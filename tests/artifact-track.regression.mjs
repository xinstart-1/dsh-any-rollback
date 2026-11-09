#!/usr/bin/env node
// 回归测试：覆盖已修复的缺陷。每个用例独立建临时工作区，
// 直接在真实实现（lib/artifact-track.js）上跑，失败即非零退出。
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactTracker } from '../lib/artifact-track.js'

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

async function setup(tag, opts = {}) {
  const base = await mkdtemp(join(tmpdir(), `anyrb-${tag}-`))
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
  await tracker.ensureBaseline('s')
  return { tracker, root, cwd, base }
}

async function cleanup(base) {
  await rm(base, { recursive: true, force: true }).catch(() => {})
}

// ── 1. 超上限且内容变化过的文件：必须跳过，不得移出工作区 ────────────────
// 语义提醒：清单 key=K 记录的是“从消息 K 开始的那一回合跑完之后”的状态，
// 所以回退到消息 K 用的是 key < K 的最后一份清单。
console.log('用例 1a：目标时刻已存在、但内容未缓存且已改动 → 必须跳过')
{
  const { tracker, cwd, base } = await setup('overcap', { maxFileBytes: 1024 })
  // 回合 10：文件已存在（超上限，hash=null，内容未缓存）
  await writeFile(join(cwd, 'deliverable.psd'), Buffer.alloc(4096, 7))
  await tracker.onTurnEnd('s', 10)
  // 回合 20：内容被改写
  await writeFile(join(cwd, 'deliverable.psd'), Buffer.alloc(4096, 8))
  await tracker.onTurnEnd('s', 20)

  // 回退到消息 20 → 目标状态是 key 10（文件存在，但其内容没备份）
  const plan = await tracker.plan('s', 20)
  const action = plan.actions.find((a) => a.rel === 'deliverable.psd')
  const skip = plan.skipped.find((s) => s.rel === 'deliverable.psd')

  check(action === undefined, '不产生 delete/quarantine 动作', JSON.stringify(action))
  check(skip !== undefined, '被记为 skipped 并给出原因', JSON.stringify(plan.skipped))

  const summary = await tracker.restore('s', 20, 999)
  check(summary.quarantine === 0, '没有文件被移入隔离区', `quarantine=${summary.quarantine}`)
  const still = await stat(join(cwd, 'deliverable.psd')).catch(() => undefined)
  check(still !== undefined, '回退后文件仍在工作区')
  await cleanup(base)
}

console.log('用例 1b：目标时刻确实不存在该文件 → 仍应隔离（原有正确行为不变）')
{
  const { tracker, cwd, base } = await setup('created', { maxFileBytes: 1024 })
  await writeFile(join(cwd, 'new-render.mp4'), Buffer.alloc(4096, 1))
  await tracker.onTurnEnd('s', 10)

  // 回退到消息 10 → 目标状态是基线（没有任何文件）
  const plan = await tracker.plan('s', 10)
  const action = plan.actions.find((a) => a.rel === 'new-render.mp4')
  check(action?.action === 'delete' && action?.reason === 'created', '被判定为新建产物', JSON.stringify(action))

  const summary = await tracker.restore('s', 10, 999)
  check(summary.quarantine === 1, '移入隔离区', `quarantine=${summary.quarantine}`)
  const gone = await stat(join(cwd, 'new-render.mp4')).catch(() => undefined)
  check(gone === undefined, '已从工作区移出')
  await cleanup(base)
}

// ── 2. 1.5 秒内的同尺寸修改：不得沿用旧摘要 ─────────────────────────────
console.log('用例 2：容差窗口内的同尺寸改写必须被记录')
{
  const { tracker, root, cwd, base } = await setup('mtime')
  await writeFile(join(cwd, 'out.txt'), 'AAAA')
  await tracker.onTurnEnd('s', 10)

  // 紧接着改写，大小相同、mtime 只差几毫秒
  await writeFile(join(cwd, 'out.txt'), 'BBBB')
  await tracker.onTurnEnd('s', 20)

  const manifest = JSON.parse(
    await readFile(join(root, 's', 'artifacts', 'manifests', `${String(20).padStart(12, '0')}.json`), 'utf8'),
  )
  const hash = manifest.files['out.txt'][2]
  // 内容现在存进全局仓 <root>/_blobs/<前2位>/<hash>（跨会话共享，见 lib/blob-store.js）。
  const blob = await readFile(join(root, '_blobs', hash.slice(0, 2), hash), 'utf8').catch(() => '(missing)')
  check(blob === 'BBBB', '清单指向改写后的内容', `实际: ${blob}`)
  await cleanup(base)
}

// ── 3. 内容缓存回收：裁掉的清单所引用的 blob 必须被清理 ──────────────────
console.log('用例 3：清单裁剪后回收不可达的内容缓存')
{
  // gcGraceMs: 0 —— 本用例验证「不可达即回收」的语义本身；生产默认 15 分钟宽限期
  // （保护「字节已落仓、清单未落盘」的窗口）另由 tests/checkpoint.cross-session.mjs 钉住。
  const { tracker, root, cwd, base } = await setup('gc', { keepManifests: 2, gcGraceMs: 0 })
  for (let turn = 1; turn <= 8; turn++) {
    await writeFile(join(cwd, 'clip.mp4'), Buffer.alloc(2048 + turn, turn))
    await tracker.onTurnEnd('s', turn * 10)
  }
  // 全局仓按 <前2位>/<hash> 分片，逐分片统计 64hex 文件数。
  const blobs = []
  for (const shard of await readdir(join(root, '_blobs')).catch(() => [])) {
    for (const name of await readdir(join(root, '_blobs', shard)).catch(() => [])) {
      if (/^[0-9a-f]{64}$/.test(name)) blobs.push(name)
    }
  }
  const manifests = (await readdir(join(root, 's', 'artifacts', 'manifests'))).filter((f) => f.endsWith('.json'))
  check(blobs.length <= manifests.length, 'blob 数量不超过存活清单引用数', `blobs=${blobs.length} manifests=${manifests.length}`)
  check(blobs.length < 8, '历史 blob 已被回收', `仍有 ${blobs.length} 个`)
  await cleanup(base)
}

// ── 4. 点目录：真实产物目录必须被追踪 ───────────────────────────────────
console.log('用例 4：点目录内的产物要被追踪')
{
  const { tracker, root, cwd, base } = await setup('dot')
  await mkdir(join(cwd, '.output'), { recursive: true })
  await writeFile(join(cwd, '.output', 'render.png'), 'x')
  await mkdir(join(cwd, '.git'), { recursive: true })
  await writeFile(join(cwd, '.git', 'index'), 'y')
  await tracker.onTurnEnd('s', 10)

  const manifests = (await readdir(join(root, 's', 'artifacts', 'manifests'))).sort()
  const last = JSON.parse(await readFile(join(root, 's', 'artifacts', 'manifests', manifests[manifests.length - 1]), 'utf8'))
  check('.output/render.png' in last.files, '点目录产物进入清单')
  check(!('.git/index' in last.files), '.git 仍被排除')
  await cleanup(base)
}

// ── 5. 清单缺失/陈旧时不得误删老文件（用户实测事故）──────────────────────
// 事故：4 轮对话一份轮次清单都没落盘（cwd 未注册时的竞态），回退到第 3 句时
// stateAt 退化到 5 小时前的旧清单，于是「旧清单没有、磁盘上有」的文件全被判成
// 「新建产物」列进删除清单 —— 用户只打了一句「测试」，却看到 5 个无关文件待删。
console.log('用例 5：清单陈旧时，早于清单的文件不得被判 created')
{
  const { tracker, root, cwd, base } = await setup('stale')
  const old = new Date(Date.now() - 7200_000)
  const older = new Date(Date.now() - 3600_000)

  // 清单：只有 a.mjs
  await writeFile(join(cwd, 'a.mjs'), 'aaa')
  await tracker.onTurnEnd('s', 10)

  // 把清单时间改成「1 小时前」，并把 a.mjs 的 mtime 也推到 2 小时前
  const mdir = join(root, 's', 'artifacts', 'manifests')
  const mp = join(mdir, '000000000010.json')
  const man = JSON.parse(await readFile(mp, 'utf8'))
  man.at = older.getTime()
  for (const rel of Object.keys(man.files)) man.files[rel][1] = old.getTime()
  await writeFile(mp, JSON.stringify(man))
  await utimes(join(cwd, 'a.mjs'), old, old)

  // 3 个「早就存在但清单漏记」的文件
  for (const name of ['b.mjs', 'c.mjs', 'd.mjs']) {
    await writeFile(join(cwd, name), 'old')
    await utimes(join(cwd, name), old, old)
  }
  // 1 个「确实在清单之后新建」的文件
  await writeFile(join(cwd, 'fresh.mjs'), 'new')

  const plan = await tracker.plan('s', 50)
  const deletes = plan.actions.filter((a) => a.action === 'delete').map((a) => a.rel)
  const skipped = plan.skipped.map((s) => s.rel)

  check(deletes.length === 1 && deletes[0] === 'fresh.mjs', '只删除清单之后新建的文件', JSON.stringify(deletes))
  check(
    ['b.mjs', 'c.mjs', 'd.mjs'].every((f) => skipped.includes(f)),
    '早于清单的文件全部跳过（不误删）',
    JSON.stringify(plan.skipped),
  )
  await cleanup(base)
}

// ── 6. cwd 兜底：注册竞态时也要能记下清单 ───────────────────────────────
console.log('用例 6：cwd 未注册时用 cwdHint 兜底记录清单')
{
  const base = await mkdtemp(join(tmpdir(), 'anyrb-hint-'))
  const root = join(base, 'snapshots')
  const cwd = join(base, 'workspace')
  await mkdir(cwd, { recursive: true })
  // cwdOf 返回 undefined —— 模拟 artifactCwds 还没注册
  const tracker = new ArtifactTracker({
    rootDir: () => root,
    cwdOf: () => undefined,
    logger: { warn() {}, error() {} },
  })
  await writeFile(join(cwd, 'x.txt'), 'x')

  const plain = await tracker.onTurnEnd('s', 10)
  check(plain === undefined, '无 cwdHint 时确实记不下来（旧行为）', String(plain))

  const withHint = await tracker.onTurnEnd('s', 10, cwd)
  check(withHint !== undefined && withHint.key === 10, 'cwdHint 兜底后清单落盘', JSON.stringify(withHint))

  const keys = await tracker.listManifestKeys('s')
  check(keys.includes(10), '清单 key 出现在列表里', JSON.stringify(keys))
  await cleanup(base)
}

// ── 7. 累积回退语义（用户明确的产品模型）────────────────────────────────
// 「第1句产生3个产物，第2句2个，第3句3个；回退第1句 → 后面几句的产物一起回退」
// 这是插件的核心承诺，也是重构 plan() 的判定基准时必须保住的语义。
console.log('用例 7：回退第 1 句 → 第 2/3 句产生的产物一起撤销')
{
  const { tracker, cwd, base } = await setup('cumul')
  const turns = [
    { seq: 10, files: ['a1.mp4', 'a2.mp4', 'a3.mp4'] },
    { seq: 20, files: ['b1.mp4', 'b2.mp4'] },
    { seq: 30, files: ['c1.mp4', 'c2.mp4', 'c3.mp4'] },
  ]
  for (const turn of turns) {
    for (const name of turn.files) await writeFile(join(cwd, name), name)
    await tracker.onTurnEnd('s', turn.seq)
  }

  const keys = await tracker.listManifestKeys('s')
  check(JSON.stringify(keys) === JSON.stringify([0, 10, 20, 30]), '三轮各记一份清单', JSON.stringify(keys))

  const plan = await tracker.plan('s', 10)
  const deletes = plan.actions.filter((a) => a.action === 'delete').map((a) => a.rel).sort()
  const expected = ['a1.mp4', 'a2.mp4', 'a3.mp4', 'b1.mp4', 'b2.mp4', 'c1.mp4', 'c2.mp4', 'c3.mp4'].sort()
  check(JSON.stringify(deletes) === JSON.stringify(expected), '三句产生的 8 个产物全部撤销', JSON.stringify(deletes))
  check(plan.coverage === 'ok', '清单完整 → 严格模式', String(plan.coverage))

  // 回到第 2 句：只撤第 2/3 句的产物，第 1 句的保留
  const plan2 = await tracker.plan('s', 20)
  const deletes2 = plan2.actions.filter((a) => a.action === 'delete').map((a) => a.rel).sort()
  const expected2 = ['b1.mp4', 'b2.mp4', 'c1.mp4', 'c2.mp4', 'c3.mp4'].sort()
  check(JSON.stringify(deletes2) === JSON.stringify(expected2), '回退第 2 句：只撤第 2/3 句的产物', JSON.stringify(deletes2))
  await cleanup(base)
}

console.log('')
console.log(failed === 0 ? `全部通过（${passed} 项）` : `失败 ${failed} 项 / 共 ${passed + failed} 项`)
process.exit(failed === 0 ? 0 : 1)
