#!/usr/bin/env node
// 端到端验证：直接对「已安装的那份」插件代码跑四个缺陷场景，
// 确认修复在真实安装件上生效（而不是只在仓库副本上）。
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'

const installed = join(
  homedir(),
  '.dsh',
  'profiles',
  'desktop',
  'node_modules',
  'dsh-any-rollback',
  'lib',
  'artifact-track.js',
)
const { ArtifactTracker } = await import(new URL(`file://${installed.replace(/\\/g, '/')}`).href)

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function setup(tag, opts = {}) {
  const base = await mkdtemp(join(tmpdir(), `verify-${tag}-`))
  const root = join(base, 'snap')
  const cwd = join(base, 'ws')
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
const done = (base) => rm(base, { recursive: true, force: true }).catch(() => {})

console.log(`被测代码: ${installed}`)
console.log('')

console.log('1) 超上限且改动的文件 → 跳过，不移出工作区')
{
  const { tracker, cwd, base } = await setup('cap', { maxFileBytes: 1024 })
  await writeFile(join(cwd, 'big.psd'), Buffer.alloc(4096, 7))
  await tracker.onTurnEnd('s', 10)
  await writeFile(join(cwd, 'big.psd'), Buffer.alloc(4096, 8))
  await tracker.onTurnEnd('s', 20)
  const plan = await tracker.plan('s', 20)
  check(!plan.actions.some((a) => a.rel === 'big.psd'), '不产生动作')
  check(plan.skipped.some((s) => s.rel === 'big.psd'), '记为 skipped')
  const r = await tracker.restore('s', 20, 999)
  check(r.quarantine === 0, '未移入隔离区')
  check((await stat(join(cwd, 'big.psd')).catch(() => undefined)) !== undefined, '文件仍在')
  await done(base)
}

console.log('2) 同尺寸快速改写 → 摘要必须更新')
{
  const { tracker, root, cwd, base } = await setup('mtime')
  await writeFile(join(cwd, 'o.txt'), 'AAAA')
  await tracker.onTurnEnd('s', 10)
  await writeFile(join(cwd, 'o.txt'), 'BBBB')
  await tracker.onTurnEnd('s', 20)
  const m = JSON.parse(
    await readFile(join(root, 's', 'artifacts', 'manifests', `${String(20).padStart(12, '0')}.json`), 'utf8'),
  )
  const blob = await readFile(join(root, 's', 'artifacts', 'blobs', m.files['o.txt'][2]), 'utf8').catch(() => '?')
  check(blob === 'BBBB', '清单指向新内容', blob)
  await done(base)
}

console.log('3) 清单裁剪后 → 孤立 blob 被回收')
{
  const { tracker, root, cwd, base } = await setup('gc', { keepManifests: 2 })
  for (let i = 1; i <= 8; i++) {
    await writeFile(join(cwd, 'clip.mp4'), Buffer.alloc(2048 + i, i))
    await tracker.onTurnEnd('s', i * 10)
  }
  const blobs = await readdir(join(root, 's', 'artifacts', 'blobs'))
  check(blobs.length < 8, '历史 blob 已清理', `仍有 ${blobs.length}`)
  await done(base)
}

console.log('4) 点目录 → 纳入追踪，.git 仍排除')
{
  const { tracker, root, cwd, base } = await setup('dot')
  await mkdir(join(cwd, '.output'), { recursive: true })
  await writeFile(join(cwd, '.output', 'r.png'), 'x')
  await mkdir(join(cwd, '.git'), { recursive: true })
  await writeFile(join(cwd, '.git', 'index'), 'y')
  await tracker.onTurnEnd('s', 10)
  const names = (await readdir(join(root, 's', 'artifacts', 'manifests'))).sort()
  const last = JSON.parse(await readFile(join(root, 's', 'artifacts', 'manifests', names[names.length - 1]), 'utf8'))
  check('.output/r.png' in last.files, '点目录产物被追踪')
  check(!('.git/index' in last.files), '.git 被排除')
  await done(base)
}

console.log('')
console.log(fail === 0 ? `安装件全部通过（${pass} 项）` : `安装件失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
