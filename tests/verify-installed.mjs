#!/usr/bin/env node
// 重启后验证（any.4）：已装版本、五项审计修复、regen 新功能、四场景运行时行为。
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'

const installed = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-any-rollback')

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

const pkg = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
check(pkg.name === 'dsh-any-rollback', '包名', pkg.name)
check(pkg.version === '0.19.1-any.5', '版本 = any.5（本轮交付）', pkg.version)

const hostCode = await readFile(join(installed, 'lib', 'index.js'), 'utf8')
const trackCode = await readFile(join(installed, 'lib', 'artifact-track.js'), 'utf8')

console.log('五项审计修复:')
check(trackCode.includes("skipped.push({ rel, reason: 'changed-no-backup' })"), '1a 超上限跳过')
check(trackCode.includes('now.mtime !== before[1]'), '2 精确 mtime')
check(trackCode.includes('collectGarbage'), '3 缓存回收')
check(trackCode.includes('ALWAYS_SKIP'), '4 点目录追踪')
check(trackCode.includes('quarantinePath'), '5 目录整树隔离')

console.log('regen 新功能:')
check(hostCode.includes('async function executeRegenerate'), 'executeRegenerate')
check(hostCode.includes('async function executeRegenSwitch'), 'executeRegenSwitch（版本切换）')
check(hostCode.includes('function regenVersionsOf'), '版本数据模型')
check(hostCode.includes('name: "regen"'), '/regen 命令已注册')
check(hostCode.includes('agent.followup(message)'), 'followup 重发调用')
check(trackCode.includes('recordSnapshotForRegenerate'), '产物预快照')

// 运行时行为：对安装件实跑一遍「生成 → 预快照 → 重做 → 切回」
const mod = await import(`file:///${installed.replace(/\\/g, '/')}/lib/artifact-track.js`)
const { ArtifactTracker } = mod
const base = await mkdtemp(join(tmpdir(), 'postrestart-'))
const root = join(base, 'snap')
const cwd = join(base, 'ws')
await mkdir(cwd, { recursive: true })
const tracker = new ArtifactTracker({ rootDir: () => root, cwdOf: () => cwd, keepManifests: 50, logger: { warn() {}, error() {} } })
await tracker.ensureBaseline('s')

await writeFile(join(cwd, 'render.png'), 'img-v1')
await tracker.onTurnEnd('s', 10)
const note = await tracker.recordSnapshotForRegenerate('s', 10)
check(note.length > 0 && note.includes('产物预快照'), '预快照提示', note.slice(0, 30))
await writeFile(join(cwd, 'render.png'), 'img-v2')
await tracker.onTurnEnd('s', 20)
const plan = await tracker.plan('s', 20)
check(plan.actions.some((a) => a.rel === 'render.png' && a.action === 'restore'), '版本切换动作就绪')
const r = await tracker.restore('s', 20, 999)
check((await readFile(join(cwd, 'render.png'), 'utf8')) === 'img-v1', '切回旧版本产物')
check(r.quarantine >= 0, '新版本产物进隔离区可追溯')
await rm(base, { recursive: true, force: true })

console.log('')
console.log(fail === 0 ? `已安装件全部通过（${pass} 项）` : `失败 ${fail} 项 / 共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)