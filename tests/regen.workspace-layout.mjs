// 回归测试：「工作区 / 会话」两层快照布局 + 跨会话扫描收窄。
//
// 背景（用户提出的优化）：快照根目录原来把每个会话平铺在根下
//   rewind-snapshots/<sessionId>/...
// 于是「同一工作区里还有哪些会话」只能靠扫全部会话回答 —— 实测 42 个会话
// 里只有 6 个属于当前工作区，跨会话归属检测因此读 99% 无关数据
// （219 份 manifest / 66MB，其中同工作区只有 52 份 / 0.6MB）。
//
// 新布局：
//   rewind-snapshots/
//     _blobs/                      全局内容仓（保留名）
//     ws-<12hex>/                  一个工作区一个文件夹
//       workspace.json             记录真实 cwd
//       <sessionId>/               会话目录
//     <sessionId>/                 旧扁平布局：启动时迁移进 ws-*/
//
// 本测试用真实 lib/index.js 里的 SnapshotStore 类（抽源码求值），在临时目录
// 上验证：
//   1) 分层目录名由 cwd 决定，同 cwd 的会话落进同一个工作区文件夹；
//   2) siblingSessionDirNames 只返回同工作区的会话（核心收益）；
//   3) 旧扁平目录会被 migrateFlatSessions 迁进对应工作区；
//   4) 迁移失败 / cwd 未知时退回旧扁平路径（不丢数据）；
//   5) ArtifactTracker 复用 SnapshotStore 的 sessionDir（单一事实来源）。
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, rename, stat, lstat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
let pass = 0
let fail = 0
function check(ok, label, detail = '') {
  if (ok) { pass++; console.log('  ok   ' + label) }
  else { fail++; console.log('  FAIL ' + label + (detail ? ` — ${detail}` : '')) }
}

const hostSrc = readFileSync(join(root, 'lib', 'index.js'), 'utf8')

// ── 抽出 SnapshotStore 类与它依赖的 helper，作为独立模块求值 ───────────────
function grabBlock(src, startPattern, label) {
  const at = src.search(startPattern)
  if (at < 0) throw new Error(`未找到 ${label}`)
  const open = src.indexOf('{', src.indexOf('(', at) >= 0 && src.indexOf('(', at) < src.indexOf('{', at) ? src.indexOf('(', at) : at)
  let depth = 0
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1) }
  }
  throw new Error(`未闭合 ${label}`)
}

function grabFunction(src, name) {
  const at = src.indexOf(`function ${name}(`)
  if (at < 0) throw new Error(`未找到 function ${name}`)
  let depth = 0
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1) }
  }
  throw new Error(`未闭合 ${name}`)
}

// 直接按花括号配对取整个类
function grabClass(src, className) {
  const at = src.indexOf(`var ${className} = class`)
  if (at < 0) throw new Error(`未找到 class ${className}`)
  let depth = 0
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1) + ';' }
  }
  throw new Error(`未闭合 class ${className}`)
}

const classSrc = grabClass(hostSrc, 'SnapshotStore')
console.log('SnapshotStore 类文本长度:', classSrc.length)

// 求值：注入 node 内置函数与 helper
const factory = new Function(
  'createHash',
  'resolve',
  'realpath',
  'join',
  'readdir',
  'readFile',
  'writeFile',
  'mkdir',
  'rename',
  'lstat',
  'stat',
  'isEnoent',
  'rm',
  'safeSessionId',
  'workspaceKeyOf',
  'normalizeWorkspace',
  'SNAPSHOT_DIR_NAME',
  'BLOBS_DIR_NAME',
  'WORKSPACE_PREFIX',
  'WORKSPACE_FILE',
  'DEFAULT_MAX_FILE_BYTES',
  'MAX_ANCHOR_GROUPS',
  `const PENDING_DIR = '.pending';
   const RESCUE_DIR = 'rescue';
   const SIDECAR_SUFFIX = '.before';
   const JOURNAL_PREFIX = 'journal-';
   const LEGACY_JOURNAL_PREFIX = 'restore-journal-';
   const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
   const COMPARE_CHUNK_BYTES = 64 * 1024;
   const REPLACEMENT_CHAR = '\uFFFD';
   const CURRENT_STORE_VERSION = 2;
   ${classSrc}
   return SnapshotStore;`,
)

const SnapshotStore = factory(
  createHash,
  (p) => p,
  async (p) => p,
  join,
  readdir,
  readFile,
  writeFile,
  mkdir,
  rename,
  lstat,
  stat,
  (error) => error?.code === 'ENOENT',
  rm,
  (id) => {
    const safe = String(id).replace(/[^a-zA-Z0-9._-]/g, '_')
    return safe === '..' || safe === '.' ? 'session' : safe
  },
  (cwd) => 'ws-' + createHash('sha256').update(cwd).digest('hex').slice(0, 12),
  async (cwd) => (typeof cwd === 'string' && cwd !== '' ? cwd : undefined),
  'rewind-snapshots',
  '_blobs',
  'ws-',
  'workspace.json',
  8 * 1024 * 1024,
  100,
)

console.log('\n1) 分层目录名由 cwd 决定')
{
  const base = await mkdtemp(join(tmpdir(), 'anyrb-ws-layout-'))
  try {
    const store = new SnapshotStore(join(base, 'snapshots'), { dshHome: base })
    check(typeof store.sessionDir === 'function', 'sessionDir 是方法')

    // 同一 cwd 的两个会话 → 同一个工作区目录
    const cwdA = join(base, 'projectA')
    const cwdB = join(base, 'projectB')
    await mkdir(cwdA, { recursive: true })
    await mkdir(cwdB, { recursive: true })

    const wsA = await store.bindSession('sess-a1', cwdA)
    const wsA2 = await store.bindSession('sess-a2', cwdA)
    const wsB = await store.bindSession('sess-b1', cwdB)

    check(wsA === wsA2, '同 cwd 的两个会话绑到同一个工作区', `${wsA} vs ${wsA2}`)
    check(wsA !== wsB, '不同 cwd 绑到不同工作区')
    check(/^ws-[0-9a-f]{12}$/.test(wsA), '工作区目录名形如 ws-<12hex>', wsA)

    const dirA1 = store.sessionDir('sess-a1')
    const dirA2 = store.sessionDir('sess-a2')
    check(dirname(dirA1) === dirname(dirA2), '同工作区会话的父目录相同', dirname(dirA1))
    check(dirname(dirA1) !== dirname(store.sessionDir('sess-b1')), '不同工作区父目录不同')

    // workspace.json 记录真实 cwd
    const meta = JSON.parse(await readFile(join(store.workspaceDir(wsA), 'workspace.json'), 'utf8'))
    check(meta.cwd === cwdA, 'workspace.json 记录真实 cwd', String(meta.cwd))

    console.log('\n2) siblingSessionDirNames 只返回同工作区会话')
    const sibA = await store.siblingSessionDirNames('sess-a1')
    check(sibA.includes('sess-a2'), '同工作区的 sess-a2 在兄弟列表里')
    check(!sibA.includes('sess-a1'), '不包含自己')
    check(!sibA.includes('sess-b1'), '不含其他工作区的会话（核心收益）', JSON.stringify(sibA))

    const sibB = await store.siblingSessionDirNames('sess-b1')
    check(!sibB.includes('sess-a1') && !sibB.includes('sess-a2'), 'B 工作区看不到 A 的会话')

    console.log('\n3) 旧扁平目录会被迁移进对应工作区')
    // 造一个旧布局会话：<root>/<sid>/artifacts/owned.json 带 cwd
    const legacyId = 'sess-legacy'
    const legacyDir = join(store.root, legacyId)
    await mkdir(join(legacyDir, 'artifacts', 'manifests'), { recursive: true })
    await writeFile(join(legacyDir, 'artifacts', 'owned.json'), JSON.stringify({ v: 1, cwd: cwdA, at: Date.now(), files: {} }), 'utf8')
    await writeFile(join(legacyDir, 'format'), '1', 'utf8')

    const store2 = new SnapshotStore(join(base, 'snapshots'), { dshHome: base })
    await store2.migrateFlatSessions()

    const nestedLegacy = join(store2.workspaceDir(wsA), legacyId)
    let migrated = false
    try { await readdir(nestedLegacy); migrated = true } catch { migrated = false }
    check(migrated, '旧扁平目录已 rename 进工作区文件夹', nestedLegacy)

    let flatGone = false
    try { await readdir(legacyDir) } catch { flatGone = true }
    check(flatGone, '旧扁平目录已不在根下')

    check(store2.workspaceOf(legacyId) === wsA, '迁移后记录了工作区绑定')

    // 迁移后它应当出现在同工作区的兄弟列表里
    const sibAfter = await store2.siblingSessionDirNames('sess-a1')
    check(sibAfter.includes(legacyId), '迁移后的旧会话参与同工作区扫描')

    console.log('\n4) cwd 未知的旧目录留在原地，仍可读')
    const unknownId = 'sess-unknown-cwd'
    await mkdir(join(store.root, unknownId, 'artifacts'), { recursive: true })
    await writeFile(join(store.root, unknownId, 'format'), '1', 'utf8')

    const store3 = new SnapshotStore(join(base, 'snapshots'), { dshHome: base })
    await store3.migrateFlatSessions()
    let stillFlat = false
    try { await readdir(join(store3.root, unknownId)); stillFlat = true } catch { stillFlat = false }
    check(stillFlat, 'cwd 未知的旧目录没有被乱迁（留在根下）')
    check(store3.workspaceOf(unknownId) === undefined, '未记录工作区绑定')
    // 未绑定时 sessionDir 必须仍指向旧扁平路径，否则数据读不到
    check(store3.sessionDir(unknownId) === join(store3.root, unknownId), '未绑定时 sessionDir 回退旧扁平路径',
      store3.sessionDir(unknownId))

    console.log('\n5) 幂等：重复绑定/迁移不报错、不重复动作')
    const again = await store2.bindSession(legacyId, cwdA)
    check(again === wsA, '重复 bindSession 幂等')
    await store2.migrateFlatSessions()
    const nestedAgain = await readdir(nestedLegacy)
    check(Array.isArray(nestedAgain), '重复 migrateFlatSessions 不破坏目录')
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => undefined)
  }
}

console.log('\n6) ArtifactTracker 复用 SnapshotStore 的会话目录（单一事实来源）')
{
  const trackSrc = readFileSync(join(root, 'lib', 'artifact-track.js'), 'utf8')
  check(/this\.sessionDirOf = typeof opts\.sessionDirOf === 'function'/.test(trackSrc),
    'ArtifactTracker 接受 sessionDirOf 解析器')
  check(/this\.siblingsOf = typeof opts\.siblingsOf === 'function'/.test(trackSrc),
    'ArtifactTracker 接受 siblingsOf 枚举器')
  check(/sessionDirOf\(sessionId\)/.test(trackSrc), 'dirOf 委托给 sessionDirOf')

  // 宿主必须把两个解析器都注入
  check(/sessionDirOf: \(sessionId\) => store\.sessionDir\(sessionId\)/.test(hostSrc),
    '宿主注入 store.sessionDir')
  check(/siblingsOf: \(sessionId\) => store\.siblingSessionDirNames\(sessionId\)/.test(hostSrc),
    '宿主注入 store.siblingSessionDirNames')

  // 跨会话扫描必须优先走 siblingDirs，而不是无条件扫根目录
  check(/await this\.siblingDirs\(sessionId\)/.test(trackSrc), 'ownershipFor 走 siblingDirs')
  check(/const siblings = await this\.siblingDirs\(sessionId\)/.test(trackSrc), 'foreignTouchedPaths 走 siblingDirs')

  // agent/created 必须在 assertKnownStoreVersion 之前绑定工作区
  const bindAt = hostSrc.indexOf('await store.bindSession(session.id, session.header.cwd)')
  const assertAt = hostSrc.indexOf('await store.assertKnownStoreVersion(session.id)', bindAt)
  check(bindAt > 0 && assertAt > bindAt, 'agent/created 先绑定工作区、再做 store IO',
    `bind@${bindAt} assert@${assertAt}`)
}

console.log('')
console.log(fail === 0 ? `全部通过（${pass} 项）` : `失败 ${fail} 项 / 共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)
