#!/usr/bin/env node
/**
 * snapshot-doctor.mjs — 回退快照仓库的「体检 / 去重 / 回收」独立维护脚本（零依赖，Node >= 22，ESM）
 *
 * ===================================================================================
 * 背景：43 GiB 事故
 * -----------------------------------------------------------------------------------
 * 插件把每个会话的文件内容以 sha256 命名存进
 *     ~/.dsh/rewind-snapshots/<sessionId>/artifacts/blobs/<sha256hex>
 * 这是「每会话一份」的内容寻址副本，从不跨会话共享。实测某个工作机上：
 *     42.32 GiB / 60 个会话 / 103,784 个 blob 文件
 *     只有 27,364 个不同的 hash 名 → 26.36 GiB 是纯跨会话重复，唯一内容仅 15.45 GiB
 *     另有 0.75 GiB 的 blob 已不被任何现存清单引用（孤儿）
 * 所有会话年龄都在 1–3 天，插件的「30 天空闲自动清理」永远触发不到；autoCleanup 默认关闭；
 * quarantine 没有 GC；/snapshot-auto-cleanup 只有 "max-total" / "compact" 的死 i18n，没有实现。
 * 于是磁盘被慢慢吃满，而用户没有任何内建手段可回收。
 *
 * 本脚本是「立即止血」方案：只读分析 + 默认预演 + 显式 --apply --yes 才动手，
 * 用硬链接合并跨会话重复副本、清掉孤儿 blob 与 .tmp-* 残留，并提供可选的会话剪枝/配额报告。
 *
 * 长期根治方案（与本脚本分开实现）：全局内容寻址 blob 仓库 lib/blob-store.js
 * —— 所有会话共享同一份 blob，引用计数管理生命周期。本脚本刻意不改动插件代码，
 *     只操作既有目录结构，因此可安全地在旧数据上先跑一遍。
 * ===================================================================================
 *
 * 用法：
 *   node scripts/snapshot-doctor.mjs                         # 只分析（默认，绝不写文件）
 *   node scripts/snapshot-doctor.mjs --json                  # 机器可读，单个 JSON 对象
 *   node scripts/snapshot-doctor.mjs --apply --dedup --gc --yes
 *   node scripts/snapshot-doctor.mjs --apply --yes            # 未指定动作时默认执行 --dedup --gc
 *   node scripts/snapshot-doctor.mjs --apply --prune-sessions 30 --yes
 *   node scripts/snapshot-doctor.mjs --quota 20                # 仅报告配额淘汰建议
 *
 * ===================================================================================
 * 安全不变量（代码中用 enforce() 逐点断言，任何一条被破坏立即中止）
 * -----------------------------------------------------------------------------------
 *  1. 绝不触碰：artifacts/quarantine/**、artifacts/snapshots/**（regen 历史快照，用户可见）、
 *     rescue/**、.pending/**、artifacts/manifests/**、owned.json、以及 <seq>/ 检查点 sidecar。
 *     其中 quarantine/ 保存着 rewind 时移出的用户原始文件的「唯一副本」，删了就永久丢失；
 *     rescue/ 是崩溃恢复用的预还原字节；.pending/ 是待提交数据。
 *  2. 绝不删除内容 sha256 与 64 位小写 hex 文件名不符的 blob。
 *  3. 预演是默认行为。任何破坏性动作都必须同时满足：--apply + 显式动作标志 + 非 TTY 下的 --yes。
 *     所有删除都打印到 stdout，并写入 root/dedup-log.jsonl（追加、只增不改）。
 *  4. 剪枝（--prune-sessions）是唯一会整目录删除的操作，且是严格显式触发的。
 *     由于整目录删除天然会波及受保护子目录，本脚本采取保守策略：除任务书要求的
 *     「非空 quarantine 拒绝」与「当前 DSH_SESSION_ID 跳过」外，还额外跳过含非空
 *     rescue/、.pending/、artifacts/snapshots/（regen 历史）、<seq>/*.before 检查点的会话，
 *     从而让「绝不触碰受保护数据」这条不变量在剪枝路径上同样成立。跳过的会话会逐条打印原因。
 *  5. 去重采用「先建临时硬链接 → 校验 → 再替换」的顺序，keeper 校验失败时整组跳过，
 *     绝不先删副本；已共享 inode（nlink>1）的副本直接跳过，避免重复释放/计数。
 *  6. 打印的路径一律用 path.relative(root, abs)，绝不输出绝对路径（隐私）。
 * ===================================================================================
 */

import {
  appendFile,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

// ---------------------------------------------------------------------------------
// 常量与基础工具
// ---------------------------------------------------------------------------------
const KIB = 1024
const MIB = 1024 ** 2
const GIB = 1024 ** 3
const DAY_MS = 24 * 60 * 60 * 1000
const SAFETY_CAP = 2n * BigInt(GIB) // --gc 的硬性大额警告阈值
/** 内容寻址 blob 名：64 位小写十六进制 sha256。清单中的 hash|null 引用同样按此校验。 */
const HEX64 = /^[0-9a-f]{64}$/
/** sha256File 复用的 1 MiB 缓冲区（所有哈希串行执行，无并发复用冲突）。 */
const SHARED_BUF = Buffer.allocUnsafe(1024 * 1024)

const DEFAULT_ROOT = join(homedir(), '.dsh', 'rewind-snapshots')

class UsageError extends Error {}

function fail(msg) {
  throw new UsageError(msg)
}

/** 安全不变量断言：条件不成立立即抛错，绝不「带病继续」。 */
function enforce(cond, msg) {
  if (!cond) throw new Error('安全不变量被破坏：' + msg)
}

function isHash(s) {
  return typeof s === 'string' && HEX64.test(s)
}

function fmt(bytes) {
  const n = typeof bytes === 'bigint' ? Number(bytes) : bytes
  if (!Number.isFinite(n)) return '?'
  if (n >= GIB) return (n / GIB).toFixed(2) + ' GiB'
  if (n >= MIB) return (n / MIB).toFixed(2) + ' MiB'
  if (n >= KIB) return (n / KIB).toFixed(2) + ' KiB'
  return String(n) + ' B'
}

function J(v) {
  if (typeof v === 'bigint') return Number(v)
  if (Array.isArray(v)) return v.map(J)
  if (v && typeof v === 'object') {
    const o = {}
    for (const k of Object.keys(v)) o[k] = J(v[k])
    return o
  }
  return v
}

/** 所有打印路径都是相对 root 的 POSIX 风格相对路径，绝不泄漏绝对路径。 */
function relPath(root, abs) {
  return relative(root, abs).split(sep).join('/')
}

/** 根目录显示：家目录下用 ~ 缩写，否则只显示占位符，绝不打印绝对路径。 */
function showRoot(root) {
  const h = homedir()
  if (root.toLowerCase().startsWith(h.toLowerCase())) {
    return '~' + root.slice(h.length).replace(/\\/g, '/')
  }
  return '<root>'
}

/** 受保护路径判定（按相对路径的段名，跨平台统一用 / 分隔）。 */
function isProtected(rel) {
  const s = rel.split('/').filter(Boolean)
  if (s.includes('quarantine')) return true
  if (s.includes('rescue')) return true
  if (s.includes('.pending')) return true
  if (s.includes('manifests')) return true
  if (s.includes('owned.json')) return true
  if (s.includes('artifacts') && s.includes('snapshots')) return true
  // 工作区分组目录 ws-<hash>/ 永远不是可删除单元：它下面装着同一工作区的
  // 全部会话。--prune-sessions 只允许删具体的会话目录（ws-x/<sid>）。
  if (s.length === 1 && s[0].startsWith('ws-')) return true
  return false
}

/** 工作区分组目录名：`ws-<hash>`，它本身不是会话，绝不可整组删除。 */
function isWorkspaceGroup(rel) {
  const s = rel.split('/').filter(Boolean)
  return s.length === 1 && s[0].startsWith('ws-')
}

/** 断言目标位于 <会话>/artifacts/blobs/ 之下且不在任何受保护目录里。 */
function assertUnderBlobs(root, abs) {
  const r = relPath(root, abs)
  enforce(!r.startsWith('..') && !isAbsolute(r), '目标越出快照根目录：' + r)
  const s = r.split('/').filter(Boolean)
  enforce(
    s.length >= 4 && s[1] === 'artifacts' && s[2] === 'blobs',
    '目标不在 <会话>/artifacts/blobs 之下：' + r,
  )
  enforce(!isProtected(r), '目标位于受保护目录：' + r)
  return r
}

/** 断言删除目标只能是 64hex blob 或 .tmp-* / .dedup-tmp-* 残留。 */
function assertDeletableBlob(root, abs) {
  const r = assertUnderBlobs(root, abs)
  const name = r.split('/').pop()
  enforce(
    HEX64.test(name) || name.startsWith('.tmp-') || name.includes('.dedup-tmp-'),
    '删除目标既不是 64hex blob 也不是临时残留：' + r,
  )
  return r
}

/** 流式 sha256：复用 1 MiB Buffer，handle.read(buf, 0, len, null) 顺序读。 */
async function sha256File(file) {
  const h = createHash('sha256')
  const handle = await open(file, 'r')
  try {
    let bytesRead
    do {
      ;({ bytesRead } = await handle.read(SHARED_BUF, 0, SHARED_BUF.length, null))
      if (bytesRead > 0) h.update(SHARED_BUF.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    await handle.close()
  }
  return h.digest('hex')
}

/**
 * 递归统计：只用 lstat，不跟随符号链接；跳过点目录但保留 .pending。
 * collect(p, name, st, rel) 可选回调，用于按文件名分类统计（检查点 .before 等）。
 */
async function walk(root, dir, collect) {
  let bytes = 0n
  let newestMs = 0
  let files = 0
  let ents
  try {
    ents = await readdir(dir, { withFileTypes: true })
  } catch {
    return { bytes, newestMs, files }
  }
  for (const e of ents) {
    const p = join(dir, e.name)
    let st
    try {
      st = await lstat(p, { bigint: true })
    } catch {
      continue
    }
    if (st.isDirectory() && e.name.startsWith('.') && e.name !== '.pending') continue
    const ms = st.mtime.getTime()
    if (ms > newestMs) newestMs = ms
    if (st.isDirectory()) {
      const sub = await walk(root, p, collect)
      bytes += sub.bytes
      if (sub.newestMs > newestMs) newestMs = sub.newestMs
      files += sub.files
    } else if (st.isFile()) {
      bytes += st.size
      files++
      if (collect) collect(p, e.name, st, relPath(root, p))
    }
  }
  return { bytes, newestMs, files }
}

// ---------------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------------
const HELP = `snapshot-doctor.mjs — 快照仓库体检 / 去重 / 回收（默认只读预演，零依赖）

用法：
  node scripts/snapshot-doctor.mjs [选项]

选项：
  --root <path>              快照根目录（默认 ~/.dsh/rewind-snapshots）
  --apply                    执行所选动作；不加任何动作标志时默认执行 --dedup --gc
  --yes                      跳过确认提示；非 TTY 下 --apply 必须显式提供
  --json                     输出单个机器可读 JSON 对象（不打印人类文本到 stdout）
  --dedup                    跨会话硬链接去重（先校验 sha256，保留路径排序第一份）
  --gc                       删除不被任何清单引用的孤儿 blob 与 .tmp-* 残留
  --prune-sessions <days>   删除「最新成员 mtime 早于 N 天」的整个会话目录（严格显式触发）
  --quota <GB>              去重/回收后仍超 G GiB 时，报告需额外淘汰的会话（仅建议，不删除）
  --help, -h                 显示本帮助

退出码： 0 成功（预演或已执行） / 2 用法错误 / 1 未预期运行错误

安全：
  * 默认只分析，不写任何文件。破坏性动作必须同时有 --apply、动作标志、以及非 TTY 下的 --yes。
  * 绝不触碰 quarantine/、snapshots/、rescue/、.pending/、manifests/、owned.json、<seq>/ 检查点。
  * 剪枝会跳过含非空 quarantine/rescue/.pending/、regen 快照、检查点 sidecar 的会话及当前 DSH_SESSION_ID 会话。
  * 所有打印路径均为相对根目录的相对路径，不输出绝对路径。

示例：
  node scripts/snapshot-doctor.mjs --json
  node scripts/snapshot-doctor.mjs --apply --dedup --gc --yes
  node scripts/snapshot-doctor.mjs --apply --prune-sessions 30 --dedup --gc --yes
`

function parseArgs(argv) {
  const o = {
    root: DEFAULT_ROOT,
    apply: false,
    yes: false,
    json: false,
    dedup: false,
    gc: false,
    pruneSessions: null,
    quota: null,
    help: false,
  }
  const boolFlags = new Set(['--apply', '--yes', '--json', '--dedup', '--gc', '--help', '-h'])
  const valueFlags = new Set(['--root', '--prune-sessions', '--quota'])

  for (let i = 0; i < argv.length; i++) {
    let a = argv[i]
    let inlineValue
    const eq = a.indexOf('=')
    if (eq > 0 && a.startsWith('--')) {
      inlineValue = a.slice(eq + 1)
      a = a.slice(0, eq)
    }

    if (a === '--help' || a === '-h') {
      o.help = true
      continue
    }
    if (boolFlags.has(a)) {
      if (inlineValue !== undefined) fail('布尔参数不接受取值：' + a)
      if (a === '--apply') o.apply = true
      else if (a === '--yes') o.yes = true
      else if (a === '--json') o.json = true
      else if (a === '--dedup') o.dedup = true
      else if (a === '--gc') o.gc = true
      continue
    }
    if (valueFlags.has(a)) {
      let v = inlineValue
      if (v === undefined) v = argv[++i]
      if (v === undefined || v === '' || v.startsWith('--')) fail('参数 ' + a + ' 缺少取值')
      if (a === '--root') {
        o.root = resolve(v)
      } else {
        // 严格数值：只接受十进制非负整数/小数，拒绝 NaN / Infinity / 0x / 负数
        if (!/^\d+(\.\d+)?$/.test(v)) fail('参数 ' + a + ' 需要非负数值，收到：' + v)
        const num = Number(v)
        if (!Number.isFinite(num) || num < 0) fail('参数 ' + a + ' 需要非负有限数值，收到：' + v)
        if (a === '--prune-sessions') o.pruneSessions = num
        else o.quota = num
      }
      continue
    }
    fail('未知参数：' + argv[i])
  }
  return o
}

// ---------------------------------------------------------------------------------
// 只读取证 / 分析
// ---------------------------------------------------------------------------------

/** 扫描所有会话的 blobs 目录，返回 hash -> 副本列表、临时残留、非法名。 */
async function scanBlobs(root, sessionNames) {
  const byHash = new Map()
  const tmp = []
  const invalid = []
  for (const s of sessionNames) {
    const dir = join(root, s, 'artifacts', 'blobs')
    let ents
    try {
      ents = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      const name = e.name
      const abs = join(dir, name)
      let st
      try {
        st = await lstat(abs, { bigint: true })
      } catch {
        continue
      }
      const rel = relPath(root, abs)
      // .tmp-* 残留，以及本脚本 dedup 失败可能遗留的 .dedup-tmp-* 临时硬链接
      if (name.startsWith('.tmp-') || name.includes('.dedup-tmp-')) {
        tmp.push({ abs, rel, name, session: s, size: st.size })
        continue
      }
      if (!e.isFile() || !HEX64.test(name)) {
        invalid.push({ abs, rel, name, session: s, size: st.size })
        continue
      }
      const entry = {
        abs,
        rel,
        name,
        session: s,
        size: st.size,
        nlink: st.nlink,
        dev: st.dev,
        ino: st.ino,
      }
      if (!byHash.has(name)) byHash.set(name, [])
      byHash.get(name).push(entry)
    }
  }
  return { byHash, tmp, invalid }
}

/** 解析所有清单，构建全局 liveHashes；损坏清单跳过并计数。 */
async function collectManifests(root, sessionNames) {
  const live = new Set()
  let total = 0
  let corrupt = 0
  let withHashes = 0
  for (const s of sessionNames) {
    const dir = join(root, s, 'artifacts', 'manifests')
    let ents
    try {
      ents = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue
      total++
      let j
      try {
        j = JSON.parse(await readFile(join(dir, e.name), 'utf8'))
      } catch {
        corrupt++
        continue
      }
      const files =
        j && typeof j === 'object' && j.files && typeof j.files === 'object' ? j.files : {}
      let any = false
      for (const v of Object.values(files)) {
        // 结构：rel -> [size, mtime, hash|null]；兼容直接给 hash 字符串的写法
        if (Array.isArray(v) && v.length >= 3 && isHash(v[2])) {
          live.add(v[2])
          any = true
        } else if (isHash(v)) {
          live.add(v)
          any = true
        }
      }
      if (any) withHashes++
    }
  }
  return { live, total, corrupt, withHashes }
}

/** 单个会话的体量画像（只读）。 */
async function measureSession(root, name) {
  const base = join(root, name)
  const total = await walk(root, base)

  const qDir = join(base, 'artifacts', 'quarantine')
  const q = await walk(root, qDir)
  let quarantineOpDirs = 0
  try {
    const es = await readdir(qDir, { withFileTypes: true })
    for (const e of es) if (e.isDirectory()) quarantineOpDirs++
  } catch {
    /* 不存在 */
  }

  const r1 = await walk(root, join(base, 'rescue'))
  const r2 = await walk(root, join(base, 'artifacts', 'rescue'))
  const regen = await walk(root, join(base, 'artifacts', 'snapshots'))
  const pending = await walk(root, join(base, '.pending'))

  let checkpointBytes = 0n
  let checkpointFiles = 0
  try {
    const es = await readdir(base, { withFileTypes: true })
    for (const e of es) {
      if (/^\d+$/.test(e.name) && e.isDirectory()) {
        await walk(root, join(base, e.name), (p, n, st) => {
          if (n.endsWith('.before')) {
            checkpointFiles++
            checkpointBytes += st.size
          }
        })
      } else if (e.name.endsWith('.before') && e.isFile()) {
        checkpointFiles++
        try {
          checkpointBytes += (await lstat(join(base, e.name), { bigint: true })).size
        } catch {
          /* 竞态消失 */
        }
      }
    }
  } catch {
    /* 不存在 */
  }

  let manifestCount = 0
  try {
    const es = await readdir(join(base, 'artifacts', 'manifests'), { withFileTypes: true })
    for (const e of es) if (e.isFile() && e.name.endsWith('.json')) manifestCount++
  } catch {
    /* 不存在 */
  }

  let hasOwnedJson = false
  try {
    await stat(join(base, 'owned.json'))
    hasOwnedJson = true
  } catch {
    /* 不存在 */
  }

  return {
    name,
    totalBytes: total.bytes,
    newestMs: total.newestMs,
    quarantineBytes: q.bytes,
    quarantineOpDirs,
    rescueBytes: r1.bytes + r2.bytes,
    rescueFiles: r1.files + r2.files,
    regenBytes: regen.bytes,
    pendingBytes: pending.bytes,
    pendingFiles: pending.files,
    checkpointBytes,
    checkpointFiles,
    manifestCount,
    hasOwnedJson,
    // 剪枝护栏：整目录删除会波及受保护子目录，故含以下任一者一律拒绝删除
    hasQuarantine: quarantineOpDirs > 0 || q.bytes > 0n,
    hasRescue: r1.files + r2.files > 0,
    hasPending: pending.files > 0,
    hasRegen: regen.files > 0,
    hasCheckpoint: checkpointFiles > 0,
  }
}

function activeSessionMatches(name, active) {
  if (!active) return false
  // name 可能是 `ws-<hash>/<sid>`（两层布局）；只比最后一段的会话名。
  const leaf = name.split('/').filter(Boolean).pop() ?? name
  return leaf === active || leaf === 'session-' + active || leaf.endsWith(active)
}

async function analyze(root, opts) {
  let rootEnts
  let rootExists = true
  try {
    rootEnts = await readdir(root, { withFileTypes: true })
  } catch {
    rootExists = false
    rootEnts = []
  }

  const sessionNames = []
  const skippedDotDirs = []
  const workspaceGroups = []
  let globalBlobStore = null
  for (const e of rootEnts) {
    if (e.name.startsWith('.')) {
      if (e.isDirectory()) skippedDotDirs.push(e.name)
      continue
    }
    if (e.name === '_blobs') {
      if (e.isDirectory()) {
        const w = await walk(root, join(root, e.name))
        globalBlobStore = { files: w.files, bytes: w.bytes, newestMs: w.newestMs }
      }
      continue // 未来的全局 blob 库，单独计数，绝不混进会话
    }
    if (!e.isDirectory()) continue
    // 布局是「工作区 / 会话」两层：ws-<hash>/ 是**分组目录**，不是会话。
    // 旧实现把它当成一个会话名，于是 measureSession 去 stat
    // ws-abc/artifacts/*、ws-abc/rescue、ws-abc/.pending 全部不存在 →
    // has* 全 false → evictable()=true → --prune-sessions 把整个工作区分组
    // 连同其中所有会话的检查点/manifest/journal/quarantine/rescue 一次删光。
    // 这里展开成真实的会话目录，并单独记下分组名，禁止对分组本身执行删除。
    if (e.name.startsWith('ws-')) {
      workspaceGroups.push(e.name)
      const inner = await readdir(join(root, e.name), { withFileTypes: true }).catch(() => [])
      for (const child of inner) {
        if (!child.isDirectory()) continue
        if (child.name === 'workspace.json') continue
        sessionNames.push(e.name + '/' + child.name)
      }
      continue
    }
    sessionNames.push(e.name)
  }
  sessionNames.sort()

  const manifests = await collectManifests(root, sessionNames)
  const scan = await scanBlobs(root, sessionNames)

  // ---- blob 聚合 ----------------------------------------------------------------
  let totalBlobBytes = 0n
  let uniqueContentBytes = 0n
  let duplicateBytes = 0n
  let duplicateCopies = 0
  let liveDuplicateBytes = 0n
  let orphanDuplicateBytes = 0n
  let orphanUniqueBytes = 0n
  let inodeSharedGroups = 0 // 任意两副本已共享 (dev,ino) 的 hash 组数
  let alreadyLinkedCopies = 0 // 与 keeper 同 inode、dedup 必须跳过的副本数
  let hashesWithDupes = 0
  let orphanCount = 0
  let orphanBytes = 0n

  const bySession = new Map()
  const rec = (s) => {
    if (!bySession.has(s)) {
      bySession.set(s, {
        session: s,
        duplicateBytes: 0n,
        orphanBytes: 0n,
        orphanUniqueBytes: 0n,
        tmpBytes: 0n,
      })
    }
    return bySession.get(s)
  }

  for (const [hash, copies] of scan.byHash) {
    const size0 = copies[0].size
    for (const c of copies) {
      totalBlobBytes += c.size
      rec(c.session)
    }
    uniqueContentBytes += size0

    const isOrphan = !manifests.live.has(hash)
    if (isOrphan) orphanUniqueBytes += size0

    if (copies.length > 1) {
      hashesWithDupes++
      const sorted = [...copies].sort((a, b) => a.rel.localeCompare(b.rel))
      for (let i = 1; i < sorted.length; i++) {
        const c = sorted[i]
        duplicateBytes += c.size
        duplicateCopies++
        if (isOrphan) orphanDuplicateBytes += c.size
        else liveDuplicateBytes += c.size
        rec(c.session).duplicateBytes += c.size
      }
      // (dev, ino) 用 BigInt 字符串键比较，避免精度丢失
      const seen = new Set()
      let anyShared = false
      for (const c of copies) {
        const k = c.dev + ':' + c.ino
        if (seen.has(k)) anyShared = true
        seen.add(k)
      }
      if (anyShared) inodeSharedGroups++
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].dev === sorted[0].dev && sorted[i].ino === sorted[0].ino) {
          alreadyLinkedCopies++
        }
      }
    }
  }

  for (const [hash, copies] of scan.byHash) {
    if (manifests.live.has(hash)) continue
    const sorted = [...copies].sort((a, b) => a.rel.localeCompare(b.rel))
    rec(sorted[0].session).orphanUniqueBytes += sorted[0].size
    for (const c of copies) {
      orphanCount++
      orphanBytes += c.size
      rec(c.session).orphanBytes += c.size
    }
  }

  let tmpCount = 0
  let tmpBytes = 0n
  for (const t of scan.tmp) {
    tmpCount++
    tmpBytes += t.size
    rec(t.session).tmpBytes += t.size
  }

  let invalidNameCount = 0
  let invalidNameBytes = 0n
  for (const x of scan.invalid) {
    invalidNameCount++
    invalidNameBytes += x.size
  }

  // ---- 安全可释放估算 ------------------------------------------------------------
  // 公式（按任务书）：重复字节 + 孤儿字节 + 临时字节。注意孤儿若有多副本，
  // 其重复份会同时被「重复字节」和「孤儿字节」计入，故公式值偏大。
  // 物理真实可释放 = 全部重复字节 + 每个孤儿 hash 仅一份的唯一字节 + 临时字节。
  const formulaTotal = duplicateBytes + orphanBytes + tmpBytes
  const effectiveTotal = duplicateBytes + orphanUniqueBytes + tmpBytes
  const overcount = orphanBytes - orphanUniqueBytes

  const bySessionList = [...bySession.values()]
    .map((x) => ({
      ...x,
      formulaTotal: x.duplicateBytes + x.orphanBytes + x.tmpBytes,
      effectiveTotal: x.duplicateBytes + x.orphanUniqueBytes + x.tmpBytes,
    }))
    .sort((a, b) => (b.formulaTotal > a.formulaTotal ? 1 : b.formulaTotal < a.formulaTotal ? -1 : 0))

  // ---- 每会话只读画像 ------------------------------------------------------------
  const sessions = []
  for (const s of sessionNames) sessions.push(await measureSession(root, s))

  let totalBytes = globalBlobStore ? globalBlobStore.bytes : 0n
  let quarantineBytes = 0n
  let quarantineOpDirs = 0
  let rescueBytes = 0n
  let regenBytes = 0n
  let checkpointBytes = 0n
  let pendingBytes = 0n
  let manifestCount = 0
  let sessionsWithQuarantine = 0
  for (const s of sessions) {
    totalBytes += s.totalBytes
    quarantineBytes += s.quarantineBytes
    quarantineOpDirs += s.quarantineOpDirs
    rescueBytes += s.rescueBytes
    regenBytes += s.regenBytes
    checkpointBytes += s.checkpointBytes
    pendingBytes += s.pendingBytes
    manifestCount += s.manifestCount
    if (s.hasQuarantine) sessionsWithQuarantine++
  }

  const active = process.env.DSH_SESSION_ID || ''
  // 剪枝护栏：与 pruneSessions() 执行路径严格一致，保证「预演报告」不会虚报可删会话
  const evictable = (s) =>
    !activeSessionMatches(s.name, active) &&
    !s.hasQuarantine &&
    !s.hasRescue &&
    !s.hasPending &&
    !s.hasRegen &&
    !s.hasCheckpoint

  // ---- --prune-sessions 会删什么（仅计算，绝不并入默认动作集）---------------------
  let prune = null
  if (opts.pruneSessions !== null) {
    const cutoffMs = Date.now() - opts.pruneSessions * DAY_MS
    const wouldDelete = []
    const skipped = []
    for (const s of sessions) {
      if (activeSessionMatches(s.name, active)) {
        skipped.push({ name: s.name, reason: '当前 DSH_SESSION_ID 活动会话' })
        continue
      }
      if (s.hasQuarantine) {
        skipped.push({ name: s.name, reason: '含非空 quarantine（含用户原始文件唯一副本，需人工删除）' })
        continue
      }
      if (s.hasRescue) {
        skipped.push({ name: s.name, reason: '含非空 rescue/（崩溃恢复字节，受安全不变量保护）' })
        continue
      }
      if (s.hasPending) {
        skipped.push({ name: s.name, reason: '含非空 .pending/（受安全不变量保护）' })
        continue
      }
      if (s.hasRegen) {
        skipped.push({ name: s.name, reason: '含 artifacts/snapshots/（regen 用户可见历史，受保护）' })
        continue
      }
      if (s.hasCheckpoint) {
        skipped.push({ name: s.name, reason: '含 <seq>/*.before 检查点 sidecar（受保护）' })
        continue
      }
      if (!evictable(s)) continue
      if (Number(s.newestMs) >= cutoffMs) continue
      wouldDelete.push({ name: s.name, bytes: s.totalBytes, newestMs: s.newestMs })
    }
    prune = {
      days: opts.pruneSessions,
      cutoffMs,
      wouldDelete,
      count: wouldDelete.length,
      bytes: wouldDelete.reduce((a, x) => a + x.bytes, 0n),
      skipped,
      activeSession: active || null,
    }
  }

  // ---- --quota 建议（报告用；执行阶段会用重测后的真实值重算）----------------------
  let quota = null
  if (opts.quota !== null) {
    const projectedBytes = totalBytes - effectiveTotal > 0n ? totalBytes - effectiveTotal : 0n
    const projectedGiB = Number(projectedBytes) / GIB
    const exceeded = projectedGiB > opts.quota
    const wouldEvict = []
    let remainGiB = projectedGiB
    if (exceeded) {
      const cands = sessions.filter(evictable).sort((a, b) => a.newestMs - b.newestMs)
      for (const s of cands) {
        if (remainGiB <= opts.quota) break
        wouldEvict.push(s.name)
        remainGiB -= Number(s.totalBytes) / GIB
      }
    }
    quota = {
      giB: opts.quota,
      projectedBytes,
      projectedGiB,
      exceeded,
      wouldEvict,
      evictCount: wouldEvict.length,
      remainingGiB: remainGiB,
      // 候选集已耗尽仍未达标时明确告知（含受保护数据的大会话不会被动到，需人工处理）
      reachable: !exceeded || remainGiB <= opts.quota,
    }
  }

  return {
    root: showRoot(root),
    rootExists,
    timestamp: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    mode: 'dry-run',
    sessionCount: sessions.length,
    skippedDotDirs,
    globalBlobStore,
    manifests: {
      total: manifests.total,
      corrupt: manifests.corrupt,
      withHashes: manifests.withHashes,
    },
    liveHashes: manifests.live.size,
    blobs: {
      files: [...scan.byHash.values()].reduce((a, c) => a + c.length, 0),
      uniqueHashes: scan.byHash.size,
      totalBytes: totalBlobBytes,
      uniqueContentBytes,
      duplicateBytes,
      duplicateCopies,
      hashesWithDupes,
      liveDuplicateBytes,
      orphanDuplicateBytes,
      inodeSharedGroups,
      alreadyLinkedCopies,
    },
    orphans: { count: orphanCount, bytes: orphanBytes, uniqueBytes: orphanUniqueBytes },
    tmp: { count: tmpCount, bytes: tmpBytes },
    invalidNames: { count: invalidNameCount, bytes: invalidNameBytes },
    safeReclaim: {
      duplicateBytes,
      orphanBytes,
      tmpBytes,
      formulaTotal,
      effectiveTotal,
      overcount,
      bySession: bySessionList,
    },
    sessions,
    totalBytes,
    physicalBytes: (await measurePhysical(root)).bytes,
    protected: {
      quarantineBytes,
      quarantineOpDirs,
      sessionsWithQuarantine,
      rescueBytes,
      regenBytes,
      checkpointBytes,
      pendingBytes,
      manifestCount,
    },
    prune,
    quota,
    // 执行阶段复用
    _scan: scan,
    _live: manifests.live,
    _sessionNames: sessionNames,
    _evictable: evictable,
    _active: active,
  }
}

// ---------------------------------------------------------------------------------
// 人类可读报告
// ---------------------------------------------------------------------------------
function printHuman(a, r) {
  const b = a.blobs
  r.out('========== 快照仓库体检 ==========')
  r.out('根目录        : ' + a.root + (a.rootExists ? '' : '（不存在，按空仓库处理）'))
  r.out('会话数        : ' + a.sessionCount + '　跳过的点目录: ' + (a.skippedDotDirs.length || 0))
  r.out(
    '全局 _blobs   : ' +
      (a.globalBlobStore ? fmt(a.globalBlobStore.bytes) + ' / ' + a.globalBlobStore.files + ' 文件（未来共享库，单独计数）' : '无'),
  )
  r.out(
    '清单          : ' + a.manifests.total + ' 个（损坏跳过 ' + a.manifests.corrupt +
      '，含有效 hash 引用 ' + a.manifests.withHashes + '）　全局 liveHashes: ' + a.liveHashes,
  )
  r.out('')
  r.out('--- blob 现状 ---')
  r.out(
    'blob 总量      : ' + fmt(b.totalBytes) + ' / ' + b.files + ' 个文件 / ' + b.uniqueHashes + ' 个不同 hash',
  )
  r.out('唯一内容      : ' + fmt(b.uniqueContentBytes) + '（每 hash 仅一份）')
  r.out(
    '跨会话重复    : ' + fmt(b.duplicateBytes) + ' / ' + b.duplicateCopies + ' 份冗余副本（' +
      b.hashesWithDupes + ' 个 hash 有多副本）',
  )
  r.out(
    '  其中 live hash 重复 ' + fmt(b.liveDuplicateBytes) + '，孤儿 hash 重复 ' + fmt(b.orphanDuplicateBytes),
  )
  r.out(
    '已共享 inode  : ' + b.inodeSharedGroups + ' 个 hash 组 / ' + b.alreadyLinkedCopies +
      ' 份与 keeper 同 inode（去重将跳过，避免重复释放）',
  )
  r.out('孤儿 blob     : ' + a.orphans.count + ' 个 / ' + fmt(a.orphans.bytes) +
    '（不属任何现存清单；唯一内容 ' + fmt(a.orphans.uniqueBytes) + '）')
  r.out('.tmp-* 残留   : ' + a.tmp.count + ' 个 / ' + fmt(a.tmp.bytes))
  r.out('非法文件名    : ' + a.invalidNames.count + ' 个 / ' + fmt(a.invalidNames.bytes) + '（绝不处理）')
  r.out('')
  r.out('--- 仓库总量与受保护数据（只读，绝不触碰） ---')
  r.out('仓库合计(逻辑): ' + fmt(a.totalBytes) + '（lstat 逐个累加，硬链接按多份计）')
  r.out('仓库合计(物理): ' + fmt(a.physicalBytes ?? 0n) + '（按 inode 去重，≈ C 盘实际占用）')
  r.out(
    'quarantine    : ' + fmt(a.protected.quarantineBytes) + ' / ' + a.protected.quarantineOpDirs +
      ' 个 op 目录 / ' + a.protected.sessionsWithQuarantine + ' 个会话（用户原始文件唯一副本）',
  )
  r.out('rescue        : ' + fmt(a.protected.rescueBytes))
  r.out('regen 快照    : ' + fmt(a.protected.regenBytes))
  r.out('检查点 sidecar: ' + fmt(a.protected.checkpointBytes))
  r.out('.pending      : ' + fmt(a.protected.pendingBytes))
  r.out('')
  r.out('--- 安全可释放估算 ---')
  r.out('公式值        : ' + fmt(a.safeReclaim.formulaTotal) +
    ' （重复 ' + fmt(a.safeReclaim.duplicateBytes) + ' + 孤儿 ' + fmt(a.safeReclaim.orphanBytes) +
    ' + 临时 ' + fmt(a.safeReclaim.tmpBytes) + '）')
  r.out('物理真实可释放: ' + fmt(a.safeReclaim.effectiveTotal) +
    ' （公式中孤儿重复份被重计 ' + fmt(a.safeReclaim.overcount) + '，已扣除）')
  const top = a.safeReclaim.bySession.filter((x) => x.formulaTotal > 0n).slice(0, 8)
  if (top.length) {
    r.out('按会话分解（公式值 top ' + top.length + '）:')
    for (const x of top) r.out('  ' + x.session + ' : ' + fmt(x.formulaTotal))
  }
  r.out('')
  if (a.prune) {
    r.out('--- --prune-sessions ' + a.prune.days + ' 天会删除（仅显式触发） ---')
    r.out('超期会话      : ' + a.prune.count + ' 个 / ' + fmt(a.prune.bytes))
    r.out('护栏跳过      : ' + a.prune.skipped.length + ' 个（quarantine/rescue/.pending/活动会话）')
    for (const s of a.prune.skipped.slice(0, 8)) r.out('  跳过 ' + s.name + ' : ' + s.reason)
  }
  if (a.quota) {
    r.out('--- --quota ' + a.quota.giB + ' GiB ---')
    r.out('预计处理后    : ' + a.quota.projectedGiB.toFixed(2) + ' GiB')
    if (a.quota.exceeded) {
      r.out('需要额外淘汰 ' + a.quota.evictCount + ' 个会话（最旧优先，仅建议）：')
      for (const n of a.quota.wouldEvict) r.out('  ' + n)
      r.out('淘汰后预计    : ' + a.quota.remainingGiB.toFixed(2) + ' GiB')
      if (!a.quota.reachable) {
        r.out('注意：可安全淘汰的会话已全部列出仍无法达标 —— 含受保护数据的大会话本脚本绝不动，需人工处理。')
      }
    } else {
      r.out('配额可满足，无需淘汰。')
    }
  }
}

// ---------------------------------------------------------------------------------
// 执行阶段（仅 --apply）
// ---------------------------------------------------------------------------------
async function dedup(root, scan, r, logLines) {
  let bytesFreed = 0n
  let done = 0
  let skippedMismatch = 0
  let skippedInode = 0
  let errors = 0
  const groups = [...scan.byHash.entries()].sort((a, b) => a[0].localeCompare(b[0]))

  for (const [hash, copies] of groups) {
    if (copies.length < 2) continue
    const sorted = [...copies].sort((a, b) => a.rel.localeCompare(b.rel))
    const keeper = sorted[0]

    // 先校验 keeper；失败则整组跳过，绝不先删任何副本
    let keeperOK = false
    try {
      keeperOK = (await sha256File(keeper.abs)) === hash
    } catch {
      keeperOK = false
    }
    if (!keeperOK) {
      skippedMismatch += sorted.length - 1
      r.out('跳过整组 ' + hash.slice(0, 12) + '… : keeper 内容校验失败，未改动任何文件')
      continue
    }

    for (let i = 1; i < sorted.length; i++) {
      const dup = sorted[i]
      if (dup.dev === keeper.dev && dup.ino === keeper.ino) {
        skippedInode++
        continue
      }
      let dupOK = false
      try {
        dupOK = (await sha256File(dup.abs)) === hash
      } catch {
        dupOK = false
      }
      if (!dupOK) {
        skippedMismatch++
        r.out('跳过 ' + dup.rel + ' : 内容 sha256 与文件名不符，绝不删除')
        continue
      }

      assertUnderBlobs(root, keeper.abs)
      const dupRel = assertDeletableBlob(root, dup.abs)
      enforce(isHash(hash), '去重 hash 非法：' + hash)
      const tmpAbs = dup.abs + '.dedup-tmp-' + process.pid + '-' + i
      assertUnderBlobs(root, tmpAbs)

      try {
        await rm(tmpAbs, { force: true }) // 清理同 pid 的陈旧临时链接
        await link(keeper.abs, tmpAbs) // 1) 先建临时硬链接
        const tmpOK = (await sha256File(tmpAbs)) === hash // 2) 校验临时链接
        if (!tmpOK) throw new Error('临时硬链接 sha256 校验失败')
        await rm(dup.abs, { force: true }) // 3) 删原副本（Windows 需先删目标）
        let renamed = false
        for (let attempt = 0; attempt < 3 && !renamed; attempt++) {
          try {
            await rename(tmpAbs, dup.abs) // 4) 原子替换（目标已不存在）
            renamed = true
          } catch {
            await new Promise((res) => setTimeout(res, 50))
          }
        }
        if (!renamed) {
          // rename 失败：从临时硬链接复制恢复，宁可不省空间也不丢数据
          await copyFile(tmpAbs, dup.abs)
          await rm(tmpAbs, { force: true })
          r.out('警告 ' + dupRel + ' : rename 失败，已用 copyFile 恢复（该份未节省空间）')
        }
        bytesFreed += dup.size
        done++
        r.out(
          '硬链接去重 ' + hash.slice(0, 12) + '… 保留 ' + keeper.rel + ' 移除 ' + dup.rel +
            ' (' + fmt(dup.size) + ')',
        )
        logLines.push({
          ts: new Date().toISOString(),
          hash,
          kept: keeper.rel,
          removed: dup.rel,
          bytes: Number(dup.size),
        })
      } catch (e) {
        errors++
        // 尽力保证 dup 仍存在：若已被删则从未删掉的 tmp 复制回来
        try {
          await lstat(dup.abs)
        } catch {
          try {
            await copyFile(tmpAbs, dup.abs)
          } catch {
            /* 无法恢复 */
          }
        }
        try {
          await rm(tmpAbs, { force: true })
        } catch {
          /* 忽略 */
        }
        r.out('错误 ' + dup.rel + ' : 去重失败并已尽力回滚 —— ' + e.message)
      }
    }
  }
  return { bytesFreed, done, skippedMismatch, skippedInode, errors }
}

async function gc(root, sessionNames, liveHashes, r, opts) {
  const fresh = await scanBlobs(root, sessionNames) // 重新扫描，绝不依赖陈旧列表
  let orphanCount = 0
  let orphanBytes = 0n
  const orphans = []
  for (const [hash, copies] of fresh.byHash) {
    if (liveHashes.has(hash)) continue
    for (const c of copies) {
      orphans.push(c)
      orphanCount++
      orphanBytes += c.size
    }
  }
  let tmpCount = 0
  let tmpBytes = 0n
  for (const t of fresh.tmp) {
    tmpCount++
    tmpBytes += t.size
  }

  if (orphanBytes + tmpBytes > SAFETY_CAP) {
    enforce(opts.yes, '大额回收缺少 --yes 确认')
    r.warn(
      '大额回收警告：孤儿 + 临时残留合计 ' + fmt(orphanBytes + tmpBytes) +
        ' > 2 GiB 安全阈值。已由 --yes 显式确认，但请核对上方清单！',
    )
  }

  let deleted = 0
  let bytesFreed = 0n
  for (const c of orphans) {
    const rel = assertDeletableBlob(root, c.abs)
    enforce(HEX64.test(c.name), 'gc 目标不是 64hex blob：' + rel)
    enforce(!liveHashes.has(c.name), 'gc 目标仍在 liveHashes 中，拒绝删除：' + rel)
    await rm(c.abs, { force: true })
    deleted++
    bytesFreed += c.size
    r.out('删除孤儿 blob ' + rel + ' (' + fmt(c.size) + ')')
  }
  for (const t of fresh.tmp) {
    const rel = assertDeletableBlob(root, t.abs)
    await rm(t.abs, { force: true, recursive: true })
    deleted++
    bytesFreed += t.size
    r.out('删除临时残留 ' + rel + ' (' + fmt(t.size) + ')')
  }
  return { deleted, bytesFreed, orphanCount, orphanBytes, tmpCount, tmpBytes }
}

async function pruneSessions(root, sessions, days, active, evictable, r) {
  const cutoffMs = Date.now() - days * DAY_MS
  let deleted = 0
  let bytesFreed = 0n
  let skipped = 0
  for (const s of sessions) {
    if (activeSessionMatches(s.name, active)) {
      r.out('剪枝跳过 ' + s.name + ' : 当前 DSH_SESSION_ID 活动会话')
      skipped++
      continue
    }
    if (s.hasQuarantine) {
      r.out('剪枝跳过 ' + s.name + ' : skipped: has unretrieved quarantine, delete manually')
      skipped++
      continue
    }
    if (s.hasRescue) {
      r.out('剪枝跳过 ' + s.name + ' : 含非空 rescue/（安全不变量保护）')
      skipped++
      continue
    }
    if (s.hasPending) {
      r.out('剪枝跳过 ' + s.name + ' : 含非空 .pending/（安全不变量保护）')
      skipped++
      continue
    }
    if (s.hasRegen) {
      r.out('剪枝跳过 ' + s.name + ' : 含 artifacts/snapshots/（regen 历史，安全不变量保护）')
      skipped++
      continue
    }
    if (s.hasCheckpoint) {
      r.out('剪枝跳过 ' + s.name + ' : 含 <seq>/*.before 检查点（安全不变量保护）')
      skipped++
      continue
    }
    // 与预演报告（analyze 的 evictable）逐条一致，杜绝「报告说跳过、执行却删了」
    enforce(evictable(s), '剪枝目标未通过护栏，拒绝删除：' + s.name)
    if (Number(s.newestMs) >= cutoffMs) continue
    const abs = join(root, s.name)
    // 整目录删除是本脚本唯一的粗粒度操作：拒绝绝对路径与反斜杠名（下方再逐段校验层级）
    enforce(!isAbsolute(s.name) && !s.name.includes('\\'), '非法会话名：' + s.name)
    // 整目录删除是本脚本唯一的粗粒度操作。s.name 可能是两段
    // `ws-<hash>/<sid>`：允许这种形状，但必须逐段校验，且**永远不允许**
    // 只删第一段（那会把整个工作区的所有会话一次删光）。
    const parts = s.name.split('/').filter(Boolean)
    enforce(!isAbsolute(s.name), '非法会话名：' + s.name)
    enforce(parts.length === 1 || (parts.length === 2 && parts[0].startsWith('ws-')), '非法会话名（层级不对）：' + s.name)
    enforce(parts.every((p) => p !== '.' && p !== '..' && !p.startsWith('.')), '拒绝删除点目录：' + s.name)
    enforce(!isWorkspaceGroup(s.name), '拒绝删除整个工作区分组（应删到具体会话）：' + s.name)
    enforce(!isProtected(s.name), '拒绝删除受保护目录：' + s.name)
    // 删除前确认目标确实在快照根内且不是根本身。
    const resolvedAbs = resolve(abs)
    const resolvedRoot = resolve(root)
    enforce(resolvedAbs !== resolvedRoot && resolvedAbs.startsWith(resolvedRoot + sep), '删除目标越出快照根：' + s.name)
    await rm(abs, { recursive: true, force: true })
    s._pruned = true
    deleted++
    bytesFreed += s.totalBytes
    r.out('删除过期会话 ' + s.name + ' (' + fmt(s.totalBytes) + ', 最新 ' + new Date(Number(s.newestMs)).toISOString() + ')')
  }
  return { deleted, bytesFreed, skipped }
}

/** 执行后重测仓库总量（只读）。 */
async function measureTotal(root) {
  let total = 0n
  let ents
  try {
    ents = await readdir(root, { withFileTypes: true })
  } catch {
    return 0n
  }
  for (const e of ents) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const w = await walk(root, join(root, e.name))
    total += w.bytes
  }
  return total
}

/**
 * 物理磁盘占用：按 (dev, ino) 去重，同一 inode 的多个硬链接目录项只算一次。
 * 去重执行后 lstat 逐个累加仍会把 7 万份硬链接算成 7 万份字节，与 C 盘实际
 * 占用差 20+ GiB；这条口径才是用户真正关心的「磁盘还剩多少空间」。
 */
async function measurePhysical(root) {
  const seen = new Set()
  let bytes = 0n
  let files = 0
  const visit = async (current) => {
    let st
    try {
      st = await lstat(current)
    } catch {
      return
    }
    if (!st.isDirectory()) {
      const key = st.dev + ':' + st.ino
      if (!seen.has(key)) {
        seen.add(key)
        bytes += BigInt(st.size)
        files++
      }
      return
    }
    let names
    try {
      names = await readdir(current)
    } catch {
      return
    }
    for (const n of names) {
      if (n.startsWith('.') && n !== '.pending') continue
      await visit(join(current, n))
    }
  }
  await visit(root)
  return { bytes, files }
}

async function execute(root, a, opts, actions, r) {
  a.mode = 'apply'
  a.actions = actions
  const exec = {
    applied: true,
    actions,
    dedup: null,
    gc: null,
    prune: null,
    quota: null,
    bytesBefore: a.totalBytes,
    bytesAfter: 0n,
    bytesFreed: 0n,
  }
  const logLines = []

  r.out('========== 执行阶段（--apply） ==========')
  r.out('动作集        : ' + actions.join(', '))
  r.out('执行前总量    : ' + fmt(exec.bytesBefore))

  if (actions.includes('dedup')) {
    r.out('--- dedup：跨会话硬链接去重 ---')
    exec.dedup = await dedup(root, a._scan, r, logLines)
    r.out('去重完成      : ' + exec.dedup.done + ' 份 / ' + fmt(exec.dedup.bytesFreed) +
      '，内容不符跳过 ' + exec.dedup.skippedMismatch + '，已共享 inode 跳过 ' + exec.dedup.skippedInode +
      '，错误 ' + exec.dedup.errors)
  }
  if (actions.includes('gc')) {
    r.out('--- gc：孤儿 blob 与 .tmp-* 回收 ---')
    exec.gc = await gc(root, a._sessionNames, a._live, r, opts)
    r.out('回收完成      : 删除 ' + exec.gc.deleted + ' 个 / ' + fmt(exec.gc.bytesFreed))
  }
  if (actions.includes('prune')) {
    r.out('--- prune-sessions ' + opts.pruneSessions + ' 天 ---')
    exec.prune = await pruneSessions(root, a.sessions, opts.pruneSessions, a._active, a._evictable, r)
    r.out('剪枝完成      : 删除 ' + exec.prune.deleted + ' 个会话 / ' + fmt(exec.prune.bytesFreed) +
      '，跳过 ' + exec.prune.skipped)
  }

  // 审计日志：root/dedup-log.jsonl，只追加、只增不改（本脚本唯一新建的持久文件）
  if (logLines.length) {
    try {
      await mkdir(root, { recursive: true })
      const logPath = join(root, 'dedup-log.jsonl')
      try {
        await stat(logPath)
      } catch {
        await writeFile(logPath, '', 'utf8')
      }
      await appendFile(logPath, logLines.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8')
      r.out('审计日志      : ' + relPath(root, logPath) + ' 追加 ' + logLines.length + ' 行')
    } catch (e) {
      r.out('警告：审计日志写入失败 —— ' + e.message)
    }
  }

  exec.bytesAfter = await measureTotal(root)
  exec.bytesFreed = exec.bytesBefore - exec.bytesAfter > 0n ? exec.bytesBefore - exec.bytesAfter : 0n

  if (opts.quota !== null) {
    const afterGiB = Number(exec.bytesAfter) / GIB
    const exceeded = afterGiB > opts.quota
    const wouldEvict = []
    let remainGiB = afterGiB
    if (exceeded) {
      const cands = a.sessions
        .filter((s) => a._evictable(s) && !s._pruned)
        .sort((x, y) => x.newestMs - y.newestMs)
      for (const s of cands) {
        if (remainGiB <= opts.quota) break
        wouldEvict.push(s.name)
        remainGiB -= Number(s.totalBytes) / GIB
      }
    }
    exec.quota = {
      giB: opts.quota,
      bytesAfter: exec.bytesAfter,
      giBAfter: afterGiB,
      exceeded,
      wouldEvict,
      evictCount: wouldEvict.length,
      remainingGiB: remainGiB,
      reachable: !exceeded || remainGiB <= opts.quota,
    }
    r.out('--- quota ' + opts.quota + ' GiB（重测后真实值） ---')
    r.out('当前总量      : ' + afterGiB.toFixed(2) + ' GiB')
    if (exceeded) {
      r.out('需要额外淘汰 ' + wouldEvict.length + ' 个会话（最旧优先，仅建议；本脚本绝不因 --quota 删除会话）：')
      for (const n of wouldEvict) r.out('  ' + n)
      r.out('说明：仅当同时给出 --prune-sessions 且候选满足其时限时，才会随剪枝删除。')
      r.out('淘汰后预计    : ' + remainGiB.toFixed(2) + ' GiB')
      if (!exec.quota.reachable) {
        r.out('注意：可安全淘汰的会话已全部列出仍无法达标 —— 含受保护数据的大会话本脚本绝不动，需人工处理。')
      }
    } else {
      r.out('配额已满足。')
    }
  }

  r.out('')
  const physical = await measurePhysical(root)
  r.out('========== 最终汇总（执行后重测） ==========')
  r.out('执行前(逻辑)  : ' + fmt(exec.bytesBefore))
  r.out('执行后(逻辑)  : ' + fmt(exec.bytesAfter))
  r.out('逻辑净释放    : ' + fmt(exec.bytesFreed) + '（孤儿 blob 等真实删除）')
  r.out('当前物理占用  : ' + fmt(physical.bytes) + ' / ' + physical.files + ' 个唯一 inode')
  r.out('说明          : 跨会话硬链接去重后，逻辑字节数变化很小，但 C 盘实际占用')
  r.out('                大幅下降（同一份字节只占一份物理空间，见 du -sh）。')
  exec.physicalAfter = physical.bytes
  a.execution = exec
  return exec
}

// ---------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(HELP)
    return
  }

  // --apply 的确认门槛：非 TTY 必须显式 --yes；TTY 下交互确认
  if (opts.apply && !opts.yes) {
    if (!process.stdin.isTTY) {
      fail('--apply 在非 TTY 环境必须显式提供 --yes（无人值守场景无法交互确认）。' +
        '请复核预演报告后加 --yes 重试。')
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    const ans = await new Promise((res) => rl.question('确认执行破坏性动作？输入 yes 继续：', res))
    rl.close()
    if (String(ans).trim().toLowerCase() !== 'yes') fail('用户取消，未修改任何文件')
    // 交互式人工确认等价于 --yes：同时满足 --gc 的 2 GiB 大额回收确认门槛
    opts.yes = true
  }

  // 输出器：--json 时人类文本收进 logs，stdout 只留一个 JSON 对象
  const r = {
    json: opts.json,
    logs: [],
    out(s) {
      const line = String(s)
      if (this.json) this.logs.push(line)
      else console.log(line)
    },
    warn(s) {
      this.out('⚠️  ' + s)
    },
  }

  // 分析阶段：始终运行，纯只读
  const a = await analyze(opts.root, opts)

  const explicitActions = []
  if (opts.dedup) explicitActions.push('dedup')
  if (opts.gc) explicitActions.push('gc')
  if (opts.pruneSessions !== null) explicitActions.push('prune')
  const actions = opts.apply ? (explicitActions.length ? explicitActions : ['dedup', 'gc']) : explicitActions

  if (!opts.json) printHuman(a, r)

  if (opts.apply) {
    if (!a.rootExists) fail('快照根目录不存在，拒绝 --apply：' + a.root)
    await execute(opts.root, a, opts, actions, r)
  } else {
    if (!opts.json) {
      r.out('')
      r.out('本次为预演，未修改任何文件；加 --apply --yes 执行')
      if (!explicitActions.length) r.out('（未指定动作；--apply 默认执行 --dedup --gc 安全组合）')
    }
  }

  if (opts.json) {
    const out = J(a)
    delete out._scan
    delete out._live
    delete out._sessionNames
    delete out._evictable
    delete out._active
    out.actions = actions
    out.logs = r.logs
    out.execution = a.execution ? J(a.execution) : null
    console.log(JSON.stringify(out, null, 2))
  }
}

main().catch((e) => {
  if (e instanceof UsageError) {
    console.error('用法错误：' + e.message)
    console.error('运行 node scripts/snapshot-doctor.mjs --help 查看帮助')
    process.exitCode = 2
  } else {
    console.error(e && e.stack ? e.stack : String(e))
    process.exitCode = 1
  }
})
