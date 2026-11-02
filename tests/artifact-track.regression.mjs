#!/usr/bin/env node
// 回归测试：覆盖已修复的四个缺陷。每个用例独立建临时工作区，
// 直接在真实实现（lib/artifact-track.js）上跑，失败即非零退出。
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises'
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
  const blob = await readFile(join(root, 's', 'artifacts', 'blobs', hash), 'utf8').catch(() => '(missing)')
  check(blob === 'BBBB', '清单指向改写后的内容', `实际: ${blob}`)
  await cleanup(base)
}

// ── 3. 内容缓存回收：裁掉的清单所引用的 blob 必须被清理 ──────────────────
console.log('用例 3：清单裁剪后回收不可达的内容缓存')
{
  const { tracker, root, cwd, base } = await setup('gc', { keepManifests: 2 })
  for (let turn = 1; turn <= 8; turn++) {
    await writeFile(join(cwd, 'clip.mp4'), Buffer.alloc(2048 + turn, turn))
    await tracker.onTurnEnd('s', turn * 10)
  }
  const blobs = await readdir(join(root, 's', 'artifacts', 'blobs'))
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

console.log('')
console.log(failed === 0 ? `全部通过（${passed} 项）` : `失败 ${failed} 项 / 共 ${passed + failed} 项`)
process.exit(failed === 0 ? 0 : 1)
