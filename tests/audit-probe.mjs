#!/usr/bin/env node
// 审计探针：针对 artifact-track.js 的高风险边界做实测。
// 每条用例独立建临时目录，输出「现象」而非「期望」，便于判断是否为缺陷。
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat, readdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactTracker } from '../lib/artifact-track.js'

const results = []
const log = (name, detail) => {
  results.push(`${name}: ${detail}`)
  console.log(`${name}: ${detail}`)
}

async function setup(tag, opts = {}) {
  const base = await mkdtemp(join(tmpdir(), `audit-${tag}-`))
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
const done = (b) => rm(b, { recursive: true, force: true }).catch(() => {})

// A. 符号链接：指向工作区外的符号链接是否会被还原/隔离？
{
  const { tracker, cwd, base } = await setup('symlink')
  const outside = join(base, 'outside.txt')
  await writeFile(outside, 'SECRET-OUTSIDE')
  try {
    await symlink(outside, join(cwd, 'link.txt'))
  } catch (e) {
    log('A 符号链接', `无法创建（${e.code}），跳过`)
  }
  await tracker.onTurnEnd('s', 10)
  const mdir = join(base, 'snap', 's', 'artifacts', 'manifests')
  const names = (await readdir(mdir)).sort()
  const last = JSON.parse(await readFile(join(mdir, names[names.length - 1]), 'utf8'))
  log('A 符号链接', `清单是否收录 link.txt=${'link.txt' in last.files}（收录则可能跟随链接读外部内容）`)
  await done(base)
}

// B. 还原目标被替换成符号链接：会不会写到工作区外？
{
  const { tracker, cwd, base } = await setup('writeout')
  await writeFile(join(cwd, 'f.txt'), 'v1')
  await tracker.onTurnEnd('s', 10)
  await writeFile(join(cwd, 'f.txt'), 'v2')
  await tracker.onTurnEnd('s', 20)
  // 回退前把 f.txt 换成指向外部的链接
  const outside = join(base, 'victim.txt')
  await writeFile(outside, 'ORIGINAL')
  await rm(join(cwd, 'f.txt'))
  try {
    await symlink(outside, join(cwd, 'f.txt'))
  } catch {
    log('B 还原穿透链接', '符号链接创建失败，跳过')
  }
  const r = await tracker.restore('s', 20, 999)
  const victim = await readFile(outside, 'utf8').catch(() => '(读不到)')
  log('B 还原穿透链接', `工作区外文件内容=${JSON.stringify(victim)}（若变成 v1 则是路径穿透缺陷）restored=${r.restored}`)
  await done(base)
}

// C. 并发：同一会话两轮同时 record，是否互相覆盖/丢清单
{
  const { tracker, cwd, base } = await setup('concurrent')
  await writeFile(join(cwd, 'a.txt'), 'one')
  const p1 = tracker.onTurnEnd('s', 10)
  await writeFile(join(cwd, 'a.txt'), 'two')
  const p2 = tracker.onTurnEnd('s', 20)
  await Promise.all([p1, p2])
  const mdir = join(base, 'snap', 's', 'artifacts', 'manifests')
  const names = (await readdir(mdir)).filter((n) => n.endsWith('.json')).sort()
  log('C 并发', `清单数=${names.length}（应含 0/10/20，共 3 份）`)
  await done(base)
}

// D. 目标文件是目录：还原时会不会把目录当文件写坏
{
  const { tracker, cwd, base } = await setup('dirclash')
  await writeFile(join(cwd, 'thing'), 'file-version')
  await tracker.onTurnEnd('s', 10)
  await rm(join(cwd, 'thing'))
  await mkdir(join(cwd, 'thing')) // 变成一个目录
  await writeFile(join(cwd, 'thing', 'inner.txt'), 'inner')
  await tracker.onTurnEnd('s', 20)
  let err
  const r = await tracker.restore('s', 20, 999).catch((e) => {
    err = e
    return undefined
  })
  const nowIsFile = (await stat(join(cwd, 'thing')).catch(() => undefined))?.isFile?.() ?? false
  log('D 文件变目录', `restore 抛错=${err ? err.message : '否'} failed=${r?.failed ?? '?'} 现在是文件=${nowIsFile}`)
  await done(base)
}

// E. 哈希碰撞/同名到不同目录：blob 是否按内容去重且能被正确还原
{
  const { tracker, cwd, base } = await setup('dup')
  await mkdir(join(cwd, 'x'))
  await mkdir(join(cwd, 'y'))
  await writeFile(join(cwd, 'x', 'same.txt'), 'SAME')
  await writeFile(join(cwd, 'y', 'same.txt'), 'SAME')
  await tracker.onTurnEnd('s', 10)
  const blobs = await readdir(join(base, 'snap', 's', 'artifacts', 'blobs'))
  log('E 内容去重', `两个同内容文件产生 blob 数=${blobs.length}（1=去重正确）`)
  await done(base)
}

// F. 清单损坏：JSON 被截断时是否静默失败（回退变成无动作）
{
  const { tracker, cwd, base } = await setup('corrupt')
  await writeFile(join(cwd, 'f.txt'), 'v1')
  await tracker.onTurnEnd('s', 10)
  const mdir = join(base, 'snap', 's', 'artifacts', 'manifests')
  const target = join(mdir, `${String(10).padStart(12, '0')}.json`)
  await writeFile(target, '{"v":1,"key":10,"files":{') // 截断
  const plan = await tracker.plan('s', 20).catch((e) => ({ error: e.message }))
  log('F 清单损坏', `plan 结果=${JSON.stringify(plan).slice(0, 120)}`)
  await done(base)
}

// G. cwd 未定义（会话无工作区）时各入口是否安全
{
  const base = await mkdtemp(join(tmpdir(), 'audit-nocwd-'))
  const tracker = new ArtifactTracker({
    rootDir: () => join(base, 'snap'),
    cwdOf: () => undefined,
    keepManifests: 5,
    logger: { warn() {}, error() {} },
  })
  const a = await tracker.onTurnEnd('s', 10).catch((e) => `throw:${e.message}`)
  const b = await tracker.plan('s', 10).catch((e) => `throw:${e.message}`)
  const c = await tracker.restore('s', 10, 999).catch((e) => `throw:${e.message}`)
  log('G 无工作区', `onTurnEnd=${JSON.stringify(a)} plan=${JSON.stringify(b)} restore=${JSON.stringify(c)}`)
  await done(base)
}

// H. 文件在 record 与 restore 之间被改名：会不会误判为「新建」从而隔离用户的旧文件
{
  const { tracker, cwd, base } = await setup('rename')
  await writeFile(join(cwd, 'old-name.txt'), 'content')
  await tracker.onTurnEnd('s', 10)
  await rename(join(cwd, 'old-name.txt'), join(cwd, 'new-name.txt'))
  await tracker.onTurnEnd('s', 20)
  const plan = await tracker.plan('s', 20)
  log(
    'H 改名',
    `old-name 动作=${JSON.stringify(plan.actions.filter((a) => a.rel.includes('old-name')))} ` +
      `new-name 动作=${JSON.stringify(plan.actions.filter((a) => a.rel.includes('new-name')).map((a) => a.action))}`,
  )
  await done(base)
}

console.log('\n--- 汇总 ---')
for (const r of results) console.log('- ' + r)
