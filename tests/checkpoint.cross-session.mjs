#!/usr/bin/env node
// 回归：跨会话回退的四条通道都不得碰别的会话的字节。
//
// 事故形状（AUDIT.md P0-2）：同一工作区 cwd 下有会话 A、B。
//   A 用 write 改过 shared.txt（A 的 checkpoint 记下改之前的旧字节）
//   B 后来把 shared.txt 改成自己的内容
//   A 执行 /rewind both →
//     mode==='both' 时**先**跑 checkpoint 侧 store.restoreAfter（直接 copyFile），
//     再跑清单侧 artifactTracker.restore（有 foreign guard）。
//   旧实现：checkpoint 侧没有任何归属判断 → 把 B 的字节覆盖成 A 的旧内容；
//   artifact 侧的 guard 跑在后面，此时已无意义。
//
// 本测试钉住四条通道（全部用真实 SnapshotStore 类 + 真实 ArtifactTracker）：
//   1) planRestore / restoreAfter 尊重 opts.isForeign
//   2) impactsAfter（影响清单预览）与实际行为一致
//   3) continueRestore（journal 崩溃补偿自动重放）也过门禁
//   4) 顺境不误伤：本会话自己的文件仍被正常还原
//
// 判定用「先红后绿」的方式表达：同一次回退，传门禁 vs 不传门禁必须结果不同。
import { createHash } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const hostSrc = await fsp.readFile(path.join(ROOT, 'lib', 'index.js'), 'utf8')

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

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
function grabFunction(src, name) {
  let at = src.indexOf(`function ${name}(`)
  if (at < 0) throw new Error(`未找到 function ${name}`)
  if (src.slice(Math.max(0, at - 6), at) === 'async ') at -= 6
  let depth = 0
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1) }
  }
  throw new Error(`未闭合 ${name}`)
}

const HELPERS = [
  'safeSessionId', 'workspaceKeyOf', 'isEnoent', 'readEntry', 'entryToJson',
  'parentStillMatches', 'isLinkEntry', 'sidecarName', 'entryFileName', 'shortHash',
  'writeJsonAtomic', 'nearestExistingAncestor', 'sameFileBytes', 'sameFileBuffer',
  'isSafeBackupRef', 'isSafeLinkRef', 'safeFileId', 'dirBytes', 'isJournalPathSafe',
  'refToSource', 'sourceToRef', 'journalToJson', 'journalFromJson', 'isJournalName',
  'journalOpIdOf', 'isRawJournalRef', 'isRestoreJournal', 'refAnchorOf', 'linkToJson',
  'dirSizeAndLastActive', 'physicalSize', 'isLinkPath', 'hashPath', 'textSourceOf',
  'isForeignPath',
]

const factory = new Function(
  'deps',
  `
  const {
    createHash, resolve, realpath, join, dirname, basename, isAbsolute, relative, sep,
    readdir, readFile, writeFile, mkdir, rename, lstat, stat, rm, copyFile, open, chmod, unlink,
    normalizeWorkspace,
  } = deps;
  const SNAPSHOT_DIR_NAME = 'rewind-snapshots';
  const BLOBS_DIR_NAME = '_blobs';
  const WORKSPACE_PREFIX = 'ws-';
  const WORKSPACE_FILE = 'workspace.json';
  const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
  const MAX_ANCHOR_GROUPS = 100;
  const PENDING_DIR = '.pending';
  const RESCUE_DIR = 'rescue';
  const SIDECAR_SUFFIX = '.before';
  const JOURNAL_PREFIX = 'journal-';
  const LEGACY_JOURNAL_PREFIX = 'restore-journal-';
  const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const COMPARE_CHUNK_BYTES = 64 * 1024;
  const REPLACEMENT_CHAR = '\\uFFFD';
  const CURRENT_STORE_VERSION = 2;
  const RESTORE_JOURNAL_STATES = new Set(['running', 'rollback-running', 'completed', 'rolled-back', 'recovery-required']);
  class UnknownStoreVersionError extends Error {
    constructor(version, source) { super('unknown store version'); this.version = version; this.source = source; }
  }
  ${HELPERS.map((n) => grabFunction(hostSrc, n)).join('\n')}
  ${grabClass(hostSrc, 'SnapshotStore')}
  return SnapshotStore;
  `,
)

const SnapshotStore = factory({
  createHash,
  resolve: path.resolve,
  realpath: fsp.realpath,
  join: path.join,
  dirname: path.dirname,
  basename: path.basename,
  isAbsolute: path.isAbsolute,
  relative: path.relative,
  sep: path.sep,
  readdir: fsp.readdir,
  readFile: fsp.readFile,
  writeFile: fsp.writeFile,
  mkdir: fsp.mkdir,
  rename: fsp.rename,
  lstat: fsp.lstat,
  stat: fsp.stat,
  rm: fsp.rm,
  copyFile: fsp.copyFile,
  open: fsp.open,
  chmod: fsp.chmod,
  unlink: fsp.unlink,
  normalizeWorkspace: async (cwdRaw) => {
    if (typeof cwdRaw !== 'string' || cwdRaw === '') return undefined
    const resolved = path.resolve(cwdRaw)
    try { return await fsp.realpath(resolved) } catch { return resolved }
  },
})

const realProbe = {
  async isLink(p) { try { return (await fsp.lstat(p)).isSymbolicLink() } catch { return false } },
  async size(p) { try { return (await fsp.stat(p)).size } catch { return undefined } },
  async matches(source, p) {
    if (source === null) { try { await fsp.stat(p); return false } catch { return true } }
    try {
      const cur = await fsp.readFile(p)
      const want = await fsp.readFile(source.path)
      return cur.equals(want)
    } catch { return false }
  },
  async copy(src, dest) {
    try {
      await fsp.copyFile(src, dest)
      return { kind: 'copied', size: (await fsp.stat(dest)).size }
    } catch (error) {
      if (error?.code === 'ENOENT') return { kind: 'absent' }
      return { kind: 'failed', error }
    }
  },
}

const { ArtifactTracker } = await import(new URL('../lib/artifact-track.js', import.meta.url).href)

/**
 * 造一个 A/B 同工作区的场景：
 *   A 的 checkpoint 记着 shared.txt 的旧字节 "v1-from-user"（锚在 seq 10）
 *   B 把 shared.txt 改成 "v2-written-by-B" 并让 B 的归属账本记下
 *   A 还拥有自己的 a-only.txt（应当被正常还原）—— 用「顺境不误伤」防假修复
 */
async function scenario(tag) {
  const base = await mkdtemp(path.join(tmpdir(), `anyrb-xsession-${tag}-`))
  const cwd = path.join(base, 'proj')
  await fsp.mkdir(cwd, { recursive: true })
  const snapRoot = path.join(base, 'snapshots')
  const store = new SnapshotStore(snapRoot, { dshHome: base })

  const A = 'sess-A'
  const B = 'sess-B'
  await store.bindSession(A, cwd)
  await store.bindSession(B, cwd)
  store.setFormatVersion(1)
  for (const sid of [A, B]) {
    await store.markFormatVersion(sid, 1)
    await store.markStoreVersion(sid, 2)
  }

  const shared = path.join(cwd, 'shared.txt')
  const aOnly = path.join(cwd, 'a-only.txt')

  // A 自己的文件：checkpoint 记下旧内容，之后被 A 改掉 → 回退应当还原它
  await fsp.writeFile(aOnly, 'a-target', 'utf8')
  const stagedAonly = await store.stageCapture(A, 'call-A-only')
  await fsp.copyFile(aOnly, stagedAonly)
  await store.recordBackup(A, { callId: 'call-A-only', anchorSeq: 10, path: aOnly },
    { file: stagedAonly, size: (await fsp.stat(stagedAonly)).size })
  await fsp.writeFile(aOnly, 'a-modified', 'utf8')

  // 共享文件：A 的 before = v1，之后 B 写成 v2
  await fsp.writeFile(shared, 'v1-from-user', 'utf8')
  const stagedShared = await store.stageCapture(A, 'call-A-shared')
  await fsp.copyFile(shared, stagedShared)
  await store.recordBackup(A, { callId: 'call-A-shared', anchorSeq: 10, path: shared },
    { file: stagedShared, size: (await fsp.stat(stagedShared)).size })

  // B 的归属账本：B 在同一工作区写下 v2，并记账（走 noteWrite，验证它真的接线了）
  const tracker = new ArtifactTracker({
    rootDir: () => snapRoot,
    // 生产里 artifactCwds 为每个会话记录 cwd（lib/index.js 的 tools/execute
    // 钩子），所以这里两个会话都要给 —— 缺 cwd 时门禁会保守拒绝一切（那是
    // 环境异常路径，由第 6 组单独覆盖）。
    cwdOf: () => cwd,
    sessionDirOf: (sid) => store.sessionDir(sid),
    siblingsOf: (sid) => store.siblingSessionDirNames(sid),
    keepManifests: 50,
    gcGraceMs: 0,
    logger: { warn() {}, error() {} },
  })
  await fsp.writeFile(shared, 'v2-written-by-B', 'utf8')
  await tracker.ensureBaseline(B)
  await tracker.noteWrite(B, shared)

  // A 侧的门禁：必须与宿主真实接线（lib/index.js 的 foreignGuardOf）一致 ——
  // checkpoint 侧用的是 isForeignAbsoluteStrict（无证据=放行），不是
  // isForeignAbsolute（无证据=拒绝，那是 artifact 侧的语义）。
  const guard = { isForeign: async (absPath) => await tracker.isForeignAbsoluteStrict(A, absPath) }
  return { base, cwd, store, tracker, guard, A, B, shared, aOnly }
}

console.log('1) planRestore：别的会话写入的路径不得进入动作清单')
{
  const s = await scenario('plan')
  try {
    const without = await s.store.planRestore(s.A, 10, realProbe)
    check(without.actions.some((a) => a.path === s.shared),
      '不传门禁时会被列入（复现旧行为，证明测试有效）',
      JSON.stringify(without.actions.map((a) => path.basename(a.path))))

    const withGuard = await s.store.planRestore(s.A, 10, realProbe, s.guard)
    check(!withGuard.actions.some((a) => a.path === s.shared),
      '传门禁后 shared.txt 被排除',
      JSON.stringify(withGuard.actions.map((a) => path.basename(a.path))))
    check(withGuard.actions.some((a) => a.path === s.aOnly),
      '顺境不误伤：A 自己的 a-only.txt 仍在动作清单里')
  } finally {
    await fsp.rm(s.base, { recursive: true, force: true }).catch(() => undefined)
  }
}

console.log('2) restoreAfter：B 的字节必须活下来，A 的文件必须还原')
{
  const s = await scenario('restore')
  try {
    const outcome = await s.store.restoreAfter(s.A, 10, (p) => fsp.rm(p, { force: true }), realProbe, s.guard)
    const sharedNow = await fsp.readFile(s.shared, 'utf8')
    const aOnlyNow = await fsp.readFile(s.aOnly, 'utf8')
    check(sharedNow === 'v2-written-by-B', 'B 写入的字节未被覆盖（核心红线）', sharedNow)
    check(aOnlyNow === 'a-target', 'A 自己的文件已正常还原（防「一律 skip」式假修）', aOnlyNow)
    check(outcome.restored.length === 1, '只还原了 1 个文件（即 a-only.txt）',
      JSON.stringify(outcome.restored.map((p) => path.basename(p))))
  } finally {
    await fsp.rm(s.base, { recursive: true, force: true }).catch(() => undefined)
  }
}

console.log('3) impactsAfter（影响清单预览）与实际动作一致')
{
  const s = await scenario('impact')
  try {
    const impacts = await s.store.impactsAfter(s.A, 10, realProbe, s.guard)
    check(!impacts.some((i) => path.basename(i.path) === path.basename(s.shared)),
      '预览不再列出会被挡掉的路径（旧实现会列出，用户看到的就是假的）',
      JSON.stringify(impacts.map((i) => path.basename(i.path))))
    check(impacts.some((i) => path.basename(i.path) === path.basename(s.aOnly)),
      '预览仍列出真正会还原的路径')
  } finally {
    await fsp.rm(s.base, { recursive: true, force: true }).catch(() => undefined)
  }
}

console.log('4) continueRestore（journal 崩溃补偿自动重放）也过门禁')
{
  const s = await scenario('journal')
  try {
    // 先跑一次带门禁的 restoreAfter，用 crash 钩子在动作之间抛错模拟崩溃，
    // 让 journal 停在 running（否则 restoreAfter 正常跑完会把 journal 标成
    // completed，continueRestore 会正确地拒绝——那样测不到补偿通道）。
    await s.store.restoreAfter(s.A, 10, (p) => fsp.rm(p, { force: true }), realProbe, {
      ...s.guard,
      crash: (where) => { if (where === 'after-action') throw new Error('simulated crash') },
    }).catch(() => undefined)
    // 手工把 B 的字节再写回去，模拟「回退后又有人改了」
    await fsp.writeFile(s.shared, 'v3-written-by-B-later', 'utf8')
    // listJournals 返回 { journals, corrupt }，不是裸数组
    const { journals: ops, corrupt } = await s.store.listJournals(s.A)
    // 注意：不能用 Array.isArray(ops) —— 无 journal 时 ops 是 []，
    // Array.isArray([]) === true，这条断言在 journal 从未落盘时照样绿（假绿）。
    // 必须断言**非空**，否则 Windows 上 ref 反斜杠导致 journal 全写不出也发现不了。
    check(Array.isArray(ops) && ops.length > 0, 'journal 落盘（崩溃补偿的前提）',
      `journals=${JSON.stringify(ops).slice(0, 60)} corrupt=${JSON.stringify(corrupt).slice(0, 120)}`)
    if (Array.isArray(ops) && ops.length > 0) {
      // 元素是 journal 对象，opId 在 id 字段上
      const last = ops[ops.length - 1]
      const opId = typeof last === 'string' ? last : (last?.id ?? last?.opId)
      check(typeof opId === 'string' && opId !== '', 'journal 有可用 opId', JSON.stringify(last).slice(0, 80))
      // 模拟「回退之后又有人改了共享文件」，然后跑崩溃补偿
      await fsp.writeFile(s.shared, 'v3-written-by-B-later', 'utf8')
      const before = await fsp.readFile(s.shared, 'utf8')
      const cont = await s.store
        .continueRestore(s.A, opId, (p) => fsp.rm(p, { force: true }), realProbe, s.guard)
        .catch(() => undefined)
      const after = await fsp.readFile(s.shared, 'utf8').catch(() => '<deleted>')
      check(after === before, '补偿重放没有覆盖 B 后来的写入', after)
      check(cont !== undefined, 'continueRestore 正常返回（未抛错）', String(cont === undefined))
    }
  } finally {
    await fsp.rm(s.base, { recursive: true, force: true }).catch(() => undefined)
  }
}

console.log('5) 门禁不可用时行为不变（没有 artifact 追踪 → 与旧版一致）')
{
  const s = await scenario('nohook')
  try {
    const outcome = await s.store.restoreAfter(s.A, 10, (p) => fsp.rm(p, { force: true }), realProbe, undefined)
    check(outcome.restored.length === 2, '不传 opts 时两个文件都还原（向后兼容）',
      String(outcome.restored.length))
  } finally {
    await fsp.rm(s.base, { recursive: true, force: true }).catch(() => undefined)
  }
}

console.log('6) 门禁抛错时必须保守跳过（不得因为检测失败就放行）')
{
  const s = await scenario('throw')
  try {
    await s.store.planRestore(s.A, 10, realProbe, {
      isForeign: async () => { throw new Error('ledger unreadable') },
    }).then((plan) => {
      check(plan.actions.length === 0, '门禁抛错 → 一个动作都不规划', String(plan.actions.length))
      check(plan.failed.some((f) => /ownership check failed/.test(f.message)),
        '抛错如实进 failed（可见，不静默）', JSON.stringify(plan.failed.map((f) => f.message)))
    })
  } finally {
    await fsp.rm(s.base, { recursive: true, force: true }).catch(() => undefined)
  }
}

console.log('7) 账本空白时靠「别的会话清单」兜底（第二证据，账本之外的通道）')
{
  // 真实缺口（本轮审计实证）：noteWrite 只挂在 write/edit 的 tools/post-execute，
  // 所以 B 经 bash 产出、子会话写入、或 noteWrite 失败时，B 的**归属账本**里
  // 没有记录。此时门禁若只查账本 → 判「无证据」→ 放行 → A 覆盖 B。
  // 清单是回合边界必落的、覆盖面更广的第二证据：只要别的会话清单里记着
  // 当前这份字节，就说明是别人写的。
  const base = await mkdtemp(path.join(tmpdir(), 'anyrb-xsession-manifest-'))
  const cwd = path.join(base, 'proj')
  await fsp.mkdir(cwd, { recursive: true })
  const snapRoot = path.join(base, 'snapshots')
  const store = new SnapshotStore(snapRoot, { dshHome: base })
  const A = 'sess-A'
  const B = 'sess-B'
  try {
    await store.bindSession(A, cwd)
    await store.bindSession(B, cwd)
    store.setFormatVersion(1)
    for (const sid of [A, B]) {
      await store.markFormatVersion(sid, 1)
      await store.markStoreVersion(sid, 2)
    }

    const shared = path.join(cwd, 'shared.txt')
    const aOnly = path.join(cwd, 'a-only.txt')

    await fsp.writeFile(aOnly, 'a-target', 'utf8')
    const stagedAonly = await store.stageCapture(A, 'call-A-only')
    await fsp.copyFile(aOnly, stagedAonly)
    await store.recordBackup(A, { callId: 'call-A-only', anchorSeq: 10, path: aOnly },
      { file: stagedAonly, size: (await fsp.stat(stagedAonly)).size })
    await fsp.writeFile(aOnly, 'a-modified', 'utf8')

    await fsp.writeFile(shared, 'v1-from-user', 'utf8')
    const stagedShared = await store.stageCapture(A, 'call-A-shared')
    await fsp.copyFile(shared, stagedShared)
    await store.recordBackup(A, { callId: 'call-A-shared', anchorSeq: 10, path: shared },
      { file: stagedShared, size: (await fsp.stat(stagedShared)).size })

    const tracker = new ArtifactTracker({
      rootDir: () => snapRoot,
      cwdOf: () => cwd,
      sessionDirOf: (sid) => store.sessionDir(sid),
      siblingsOf: (sid) => store.siblingSessionDirNames(sid),
      keepManifests: 50,
      gcGraceMs: 0,
      logger: { warn() {}, error() {} },
    })
    await tracker.ensureBaseline(A)
    await tracker.ensureBaseline(B)

    // B 经 bash 写 v2（不走 noteWrite），随后回合正常结束 → 只有清单记录
    await fsp.writeFile(shared, 'v2-written-by-B', 'utf8')
    await tracker.onTurnEnd(B, 20)
    // 关键：抹掉 B 的归属账本，模拟「账本里确实没有 B 的记录」
    await fsp.rm(path.join(store.sessionDir(B), 'artifacts', 'owned.json'), { force: true })
      .catch(() => undefined)
    const ownedB = await tracker.readOwned(B)
    check(ownedB === undefined || ownedB.files?.['shared.txt'] === undefined,
      '前提：B 的归属账本里没有 shared.txt（否则测不到清单这条证据）',
      JSON.stringify(ownedB?.files ?? null))

    const guard = { isForeign: async (absPath) => await tracker.isForeignAbsoluteStrict(A, absPath) }
    check(await guard.isForeign(shared) === true,
      '账本空白时仍判定为 foreign（清单证据独立生效）')

    const outcome = await store.restoreAfter(A, 10, (p) => fsp.rm(p, { force: true }), realProbe, guard)
    const sharedNow = await fsp.readFile(shared, 'utf8')
    check(sharedNow === 'v2-written-by-B', 'B 经 bash 写入的字节未被覆盖', sharedNow)
    check(outcome.restored.includes(aOnly), 'A 自己的文件仍被还原（未因补证据而误伤）',
      JSON.stringify(outcome.restored.map((p) => path.basename(p))))
  } finally {
    await fsp.rm(base, { recursive: true, force: true }).catch(() => undefined)
  }
}

console.log('')
console.log(fail === 0 ? `全部通过（${pass} 项）` : `失败 ${fail} 项 / 共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)
