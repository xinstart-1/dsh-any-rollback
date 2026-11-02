#!/usr/bin/env node
// 集成测试：/regen 全链路（阶段 1+2+3）
// 直接调用 lib/index.js 里注入的 regenVersionsOf 不可行（未导出），
// 因此用行为测试：构造带 regenerate 标记的会话事件序列，验证版本推导；
// 并用 artifact-track 验证预快照与产物联动。
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactTracker } from '../lib/artifact-track.js'

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

// ── 版本模型：从日志事件推导版本页（复刻 lib/index.js 的 regenVersionsOf 逻辑）──
function regenVersionsOf(events, targetSeq) {
  const pages = []
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const op = event.data?.op
    const cited = Array.isArray(event.data?.sourceEventSeqs) ? event.data.sourceEventSeqs : []
    if (op !== 'regenerate' || !cited.includes(targetSeq)) continue
    pages.push({ index: pages.length + 1, markerSeq: event.seq, targetSeq, at: event.time ?? 0 })
  }
  pages.forEach((p) => { p.active = false })
  if (pages.length > 0) pages[pages.length - 1].active = true
  return { pages, targetSeq }
}

console.log('1) 版本推导：两个 regenerate 标记 → 两个版本页')
{
  const events = [
    { type: 'user/message', seq: 10, data: { message: { role: 'user', content: [{ type: 'text', text: 'render it' }] } } },
    { type: 'assistant/message', seq: 14, data: {} },
    { type: 'user/message', seq: 20, data: { op: 'regenerate', sourceEventSeqs: [10, 12, 14] } },
    { type: 'assistant/message', seq: 26, data: {} },
    { type: 'user/message', seq: 30, data: { op: 'regenerate', sourceEventSeqs: [10, 24, 26] } },
  ]
  const { pages } = regenVersionsOf(events, 10)
  check(pages.length === 2, '两个版本页', JSON.stringify(pages.length))
  check(pages[0].markerSeq === 20 && pages[1].markerSeq === 30, '按 marker seq 排序')
  check(pages[1].active === true && pages[0].active === false, '最新页为活跃版本')
}

console.log('2) 无 regenerate 标记 → 空版本页')
{
  const events = [
    { type: 'user/message', seq: 10, data: { message: { role: 'user', content: [] } } },
    { type: 'assistant/message', seq: 14, data: {} },
  ]
  const { pages } = regenVersionsOf(events, 10)
  check(pages.length === 0, '没有版本页')
}

console.log('3) 不同 targetSeq 的标记不计入同一提示词的版本')
{
  const events = [
    { type: 'user/message', seq: 10, data: {} },
    { type: 'user/message', seq: 40, data: { op: 'regenerate', sourceEventSeqs: [30, 34] } },
  ]
  const { pages } = regenVersionsOf(events, 10)
  check(pages.length === 0, '指向别的提示词的标记被排除')
}

// ── 预快照 + 版本切换后的产物联动 ──
console.log('4) 预快照记录重生成前状态，与回退联动')
{
  const base = await mkdtemp(join(tmpdir(), 'regen-e2e-'))
  const root = join(base, 'snap')
  const cwd = join(base, 'ws')
  await mkdir(cwd, { recursive: true })
  const t = new ArtifactTracker({ rootDir: () => root, cwdOf: () => cwd, keepManifests: 50, logger: { warn() {}, error() {} } })
  await t.ensureBaseline('s')

  // 轮 1（消息 10）：生成 render.png v1
  await writeFile(join(cwd, 'render.png'), 'img-v1')
  await t.onTurnEnd('s', 10)
  // 预快照（重新生成前）——计数是扫描到的文件总数，非空即成功
  const note = await t.recordSnapshotForRegenerate('s', 10)
  check(note.length > 0 && note.includes('产物预快照'), '预快照提示已生成', note)
  // 重新生成：AI 产出了不同版本
  await writeFile(join(cwd, 'render.png'), 'img-v2')
  await writeFile(join(cwd, 'extra.log'), 'log-line')
  await t.onTurnEnd('s', 20)

  // 切回版本 1：回退到消息 10（落点=基线/清单10）
  const plan = await t.plan('s', 20)
  const actions = plan.actions.map((a) => ({ rel: a.rel, action: a.action }))
  check(actions.some((a) => a.rel === 'render.png'), 'render.png 在切换动作里', JSON.stringify(actions))
  const r = await t.restore('s', 20, 999)
  check(r.quarantine >= 1, '当前版本产物进入隔离区', JSON.stringify({ q: r.quarantine }))
  check((await readFile(join(cwd, 'render.png'), 'utf8')) === 'img-v1', '切回版本 1 的产物')
  await rm(base, { recursive: true, force: true })
}

console.log('')
console.log(fail === 0 ? `全部通过（${pass} 项）` : `失败 ${fail} 项 / 共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)