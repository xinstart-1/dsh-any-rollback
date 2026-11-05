#!/usr/bin/env node
// 集成测试：全局内容寻址 blob 仓（lib/blob-store.js）+ ArtifactTracker 接入。
//
// 背景：旧版每个会话各自存一份 <root>/<sid>/artifacts/blobs/<hash>，同一份
// 64 MiB 视频在 N 个会话里存 N 份 —— 实测 41.8 GiB 里只有 15.5 GiB 唯一内容。
// 本测试锁定「全机一份字节」这个不变式，并验证旧数据仍可读、可被收编。
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ArtifactTracker } from '../lib/artifact-track.js'
import { BlobStore } from '../lib/blob-store.js'

let passed = 0
let failed = 0

function check(ok, label, detail = '') {
  if (ok) {
    passed++
    console.log(`  ok   ${label}`)
  } else {
    failed++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const sha = (s) => createHash('sha256').update(s).digest('hex')

async function setup(tag, opts = {}) {
  const base = await mkdtemp(join(tmpdir(), `anyrb-blob-${tag}-`))
  const root = join(base, 'snapshots')
  const cwd = join(base, 'workspace')
  await mkdir(cwd, { recursive: true })
  const tracker = new ArtifactTracker({
    rootDir: () => root,
    cwdOf: () => cwd,
    keepManifests: 50,
    logger: { warn() {}, error() {} },
    ...opts,
  })
  await tracker.initBlobs()
  return { tracker, root, cwd, base }
}
async function cleanup(base) {
  await rm(base, { recursive: true, force: true }).catch(() => {})
}
async function globalBlobs(root) {
  const out = []
  for (const shard of await readdir(join(root, '_blobs')).catch(() => [])) {
    for (const name of await readdir(join(root, '_blobs', shard)).catch(() => [])) {
      if (/^[0-9a-f]{64}$/.test(name)) out.push({ shard, name, path: join(root, '_blobs', shard, name) })
    }
  }
  return out
}

// ── 1. 同一内容跨会话只存一份 ─────────────────────────────────────────────
console.log('用例 1：相同字节在多个会话里只落一份物理副本')
{
  const { tracker, root, cwd, base } = await setup('cross')
  const big = 'X'.repeat(4096)
  // 三个会话各自先建基线（此时工作区为空、baselineContent=false → 不缓存内容），
  // 然后同一份字节出现在工作区里，每个会话在回合边界各自观测到它。
  for (const sid of ['s-A', 's-B', 's-C']) await tracker.ensureBaseline(sid)
  await writeFile(join(cwd, 'render.bin'), big)
  for (const sid of ['s-A', 's-B', 's-C']) {
    await tracker.onTurnEnd(sid, 10)
  }
  const blobs = await globalBlobs(root)
  const expected = sha(big)
  check(blobs.length === 1, '全局仓只有 1 个 blob', JSON.stringify(blobs.map((b) => b.name)))
  check(blobs[0]?.name === expected, 'blob 名 = 内容 sha256')
  check((await readFile(blobs[0].path, 'utf8')) === big, 'blob 内容正确')
  // 旧布局目录不该再写入内容（只有临时文件被清掉后为空或不存在）。
  const legacy = await readdir(join(root, 's-A', 'artifacts', 'blobs')).catch(() => [])
  check(legacy.filter((n) => /^[0-9a-f]{64}$/.test(n)).length === 0, '旧会话 blobs/ 不再写入内容')
  // 三个会话的还原都能读到这份字节。
  let allReadable = true
  for (const sid of ['s-A', 's-B', 's-C']) {
    const p = await tracker.blobPath(sid, expected)
    if (p === undefined || (await readFile(p, 'utf8')) !== big) allReadable = false
  }
  check(allReadable, '三个会话都能通过 blobPath 读到全局副本')
  await cleanup(base)
}

// ── 2. 不同内容各存一份；内容变化后旧 blob 不再可达即被回收 ────────────────
console.log('用例 2：内容变化生成新 blob，裁剪清单后旧 blob 被全局 GC 回收')
{
  const { tracker, root, cwd, base } = await setup('gc', { keepManifests: 2 })
  for (let turn = 1; turn <= 8; turn++) {
    await writeFile(join(cwd, 'clip.mp4'), Buffer.alloc(2048 + turn, turn))
    await tracker.onTurnEnd('s', turn * 10)
  }
  const blobs = await globalBlobs(root)
  const manifests = (await readdir(join(root, 's', 'artifacts', 'manifests'))).filter((f) => f.endsWith('.json'))
  check(blobs.length <= manifests.length, '存活 blob 不超过存活清单数', `blobs=${blobs.length} manifests=${manifests.length}`)
  check(blobs.length < 8, '历史 blob 已被回收', `仍有 ${blobs.length} 个`)
  await cleanup(base)
}

// ── 3. 旧版每会话 blob 仍能被读取并收编进全局仓 ───────────────────────────
console.log('用例 3：遗留 per-session blob 可读、可被 compact 收编')
{
  const { tracker, root, cwd, base } = await setup('legacy')
  const content = 'legacy-bytes'
  const hash = sha(content)
  // 手工造一份旧布局 blob（模拟升级前的数据）。
  const legacyDir = join(root, 's', 'artifacts', 'blobs')
  await mkdir(legacyDir, { recursive: true })
  await writeFile(join(legacyDir, hash), content)
  // 未收编时也能读到旧字节（兼容性）。
  const before = await tracker.blobPath('s', hash)
  check(before === join(legacyDir, hash), '升级前旧 blob 仍可读', String(before))
  // 收编：全局仓出现同内容，旧链接被删。
  const report = await tracker.compactIntoGlobal({ dryRun: false })
  const after = await tracker.blobPath('s', hash)
  check(after === join(root, '_blobs', hash.slice(0, 2), hash), '收编后指向全局仓', String(after))
  check((await readFile(after, 'utf8')) === content, '收编后内容不变')
  check((await lstat(join(legacyDir, hash)).catch(() => null)) === null, '旧会话副本已删除')
  check(report.adopted + report.deduped > 0, 'compact 报告统计到收编动作', JSON.stringify(report))
  await cleanup(base)
}

// ── 4. dryRun 不写盘 ───────────────────────────────────────────────────────
console.log('用例 4：compact --dry-run 只报告不修改任何文件')
{
  const { tracker, root, base } = await setup('dry')
  const content = 'dry-run-content'
  const hash = sha(content)
  const legacyDir = join(root, 's', 'artifacts', 'blobs')
  await mkdir(legacyDir, { recursive: true })
  await writeFile(join(legacyDir, hash), content)
  const report = await tracker.compactIntoGlobal({ dryRun: true })
  check(report.dryRun === true, '报告标记为 dryRun')
  check((await lstat(join(root, '_blobs', hash.slice(0, 2), hash)).catch(() => null)) === null, '全局仓未写入')
  check((await lstat(join(legacyDir, hash)).catch(() => null)) !== null, '旧 blob 仍在')
  await cleanup(base)
}

// ── 5. 投毒清单的非法 hash 绝不进 blob 路径 ────────────────────────────────
console.log('用例 5：非法 hash / 路径注入一律拒绝')
{
  const { tracker, root, base } = await setup('inject')
  const bs = new BlobStore({ rootDir: () => root })
  await bs.init()
  for (const bad of ['../../etc/passwd', 'ABC', 'a/../../x', 'C:/Windows/x', '', 'x'.repeat(64)]) {
    check(bs.globalPath(bad) === undefined, `拒绝 ${JSON.stringify(bad)}`)
  }
  check((await tracker.blobPath('s', '../secret')) === undefined, 'blobPath 拒绝越界 hash')
  await cleanup(base)
}

// ── 6. BlobStore.stats / collectGarbage 全局可达性 ─────────────────────────
console.log('用例 6：GC 只删全局不可达 blob，且尊重字节上限')
{
  const { tracker, root, base } = await setup('stats')
  const bs = new BlobStore({ rootDir: () => root })
  await bs.init()
  const live = new Set()
  for (const text of ['a', 'b', 'c', 'd']) {
    const tmp = join(root, 'tmp-' + text)
    await writeFile(tmp, text)
    const r = await bs.putFromTemp(tmp, sha(text))
    check(r.ok === true, `putFromTemp(${text}) 成功`, JSON.stringify(r))
    if (text !== 'd') live.add(sha(text))
  }
  const s = await bs.stats()
  check(s.files === 4 && s.bytes === 4, 'stats 统计 4 个 blob / 4 字节', JSON.stringify(s))
  const capped = await bs.collectGarbage(live, { maxDeleteBytes: 0 })
  check(capped.removed === 0, 'maxDeleteBytes=0 时不删任何文件')
  const gc = await bs.collectGarbage(live)
  check(gc.removed === 1 && gc.removedBytes === 1, '只回收 1 个不可达 blob', JSON.stringify(gc))
  const s2 = await bs.stats()
  check(s2.files === 3, 'GC 后剩 3 个 blob', JSON.stringify(s2))
  await cleanup(base)
}

console.log(`\n${failed === 0 ? '全部通过' : '失败'}：${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
