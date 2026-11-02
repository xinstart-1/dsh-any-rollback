#!/usr/bin/env node
// 回归测试：整体审计发现的问题（v0.19.1-any.3 修复项）。
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactTracker } from '../lib/artifact-track.js'

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
  const base = await mkdtemp(join(tmpdir(), `auditfix-${tag}-`))
  const root = join(base, 'snap')
  const cwd = join(base, 'ws')
  await mkdir(cwd, { recursive: true })
  const tracker = new ArtifactTracker({
    rootDir: () => root,
    cwdOf: () => cwd,
    keepManifests: 50,
    logger: { warn(msg) { tracker.__warnings = tracker.__warnings ?? []; tracker.__warnings.push(msg) }, error() {} },
    ...opts,
  })
  await tracker.ensureBaseline('s')
  return { tracker, root, cwd, base }
}
const done = (b) => rm(b, { recursive: true, force: true }).catch(() => {})
const walk = async (d, out = []) => {
  for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
    const p = join(d, e.name)
    if (e.isDirectory()) await walk(p, out)
    else out.push(p)
  }
  return out
}

console.log('用例 5：目标位置变成目录时 → 目录整体隔离（保数据），还原照常完成')
{
  const { tracker, root, cwd, base } = await setup('dirc')
  await writeFile(join(cwd, 'thing'), 'file-content')
  await tracker.onTurnEnd('s', 10)
  // thing 变成目录，里面是用户数据
  await rm(join(cwd, 'thing'))
  await mkdir(join(cwd, 'thing'))
  await writeFile(join(cwd, 'thing', 'inside.txt'), 'IMPORTANT-USER-DATA')
  await tracker.onTurnEnd('s', 20)

  const r = await tracker.restore('s', 20, 999)
  check(r.restored === 1, '还原动作成功完成', JSON.stringify({ restored: r.restored, failed: r.failed }))
  check(r.failed === 0, '没有失败项', JSON.stringify(r.errors))

  const isFile = (await stat(join(cwd, 'thing')).catch(() => undefined))?.isFile?.() ?? false
  check(isFile, 'thing 已还原为文件')

  // 目录内容必须完整保留在隔离区
  const qfiles = r.dir ? await walk(r.dir) : []
  const inner = qfiles.find((f) => f.endsWith('inside.txt'))
  check(inner !== undefined, '目录内容保留在隔离区')
  if (inner) {
    check(
      (await readFile(inner, 'utf8')) === 'IMPORTANT-USER-DATA',
      '隔离区内容完整',
    )
  }
  // index.json 记录了原路径
  if (r.dir) {
    const idx = JSON.parse(await readFile(join(r.dir, 'index.json'), 'utf8'))
    check(
      idx.items.some((it) => it.path.includes('inside.txt') && it.reason === 'replaced-by-restore'),
      'index.json 记录原因 replaced-by-restore',
    )
  }
  // 残留 tmp 已清理
  const leftovers = (await readdir(cwd)).filter((n) => n.includes('.rewind-'))
  check(leftovers.length === 0, '无 tmp 残留', leftovers.join(', '))
  await done(base)
}

console.log('用例 6：还原流程的临时文件不进清单，遗留 tmp 被清理')
{
  const { tracker, root, cwd, base } = await setup('tmpclean')
  await writeFile(join(cwd, 'f.txt'), 'v1')
  await tracker.onTurnEnd('s', 10)
  await writeFile(join(cwd, 'f.txt'), 'v2')
  await tracker.onTurnEnd('s', 20)

  // 模拟上次还原失败留下的 tmp
  // 只清理本进程 pid 且同名原始文件存在的残留（旧实现按模式误删用户文件）
  await writeFile(join(cwd, 'f.txt.rewind-' + process.pid + '.tmp'), 'leftover')
  await writeFile(join(cwd, 'keep.rewind-456.tmp'), 'user-owned-not-ours')

  // tmp 不得进入边界清单
  await tracker.onTurnEnd('s', 30)
  const mdir = join(root, 's', 'artifacts', 'manifests')
  const names = (await readdir(mdir)).sort()
  const m30 = JSON.parse(await readFile(join(mdir, names[names.length - 1]), 'utf8'))
  check(
    !Object.keys(m30.files).some((k) => k.includes('.rewind-')),
    'tmp 文件不进入清单',
    Object.keys(m30.files).filter((k) => k.includes('.rewind-')).join(', '),
  )
  check('f.txt' in m30.files, '真实文件正常追踪')

  // 还原后遗留 tmp 被清扫；落点状态是清单 10（f.txt = v1）
  await tracker.restore('s', 20, 999)
  const leftovers = (await readdir(cwd)).filter((n) => n.includes('.rewind-'))
  check(!leftovers.includes('f.txt.rewind-' + process.pid + '.tmp'), '本进程残留被清理', leftovers.join(', '))
  check(leftovers.includes('keep.rewind-456.tmp'), '非本进程命名的文件不被误删')
  check((await readFile(join(cwd, 'f.txt'), 'utf8')) === 'v1', '还原为落点状态的内容（v1）')
  await done(base)
}

console.log('用例 7：finishRestore 不再用 size 复用摘要')
{
  const { tracker, root, cwd, base } = await setup('finish')
  await writeFile(join(cwd, 'f.txt'), 'AAAA')
  await tracker.onTurnEnd('s', 10)
  await writeFile(join(cwd, 'f.txt'), 'BBBB')
  await tracker.onTurnEnd('s', 20)

  // 回退到消息 20（还原为 AAAA），finishRestore 写 marker 清单
  await tracker.restore('s', 20, 999)
  const m = JSON.parse(
    await readFile(join(root, 's', 'artifacts', 'manifests', `${String(999).padStart(12, '0')}.json`), 'utf8'),
  )
  const hash = m.files['f.txt'][2]
  if (hash === null) {
    check(true, '无法确认时写 null（下次边界重新计算）')
  } else {
    const blob = await readFile(join(root, 's', 'artifacts', 'blobs', hash), 'utf8')
    check(blob === 'AAAA', '记录的摘要与实际内容一致', blob)
  }
  await done(base)
}

console.log('用例 8：清单损坏 → 记录警告而非静默')
{
  const { tracker, root, cwd, base } = await setup('corrupt')
  await writeFile(join(cwd, 'd.txt'), 'v1')
  await tracker.onTurnEnd('s', 10)
  const mdir = join(root, 's', 'artifacts', 'manifests')
  await writeFile(join(mdir, `${String(10).padStart(12, '0')}.json`), '{"v":1,"key":10,"fil')

  tracker.__warnings = tracker.__warnings ?? []
  await tracker.plan('s', 20)
  check(
    (tracker.__warnings ?? []).some((w) => w.includes('corrupt') || w.includes('unrecognized')),
    '输出警告',
    JSON.stringify(tracker.__warnings ?? []),
  )
  check(
    (tracker.__warnings ?? []).some((w) => w.includes('10')),
    '警告里带清单标识，可定位',
  )
  await done(base)
}

console.log('')
console.log(fail === 0 ? `全部通过（${pass} 项）` : `失败 ${fail} 项 / 共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)