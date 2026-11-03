// 回归测试（真实事故复现）：「回退后，上面的会话没有消失」
//
// 真实日志 session-0a61f77f-9f7f-4211-84ac-1422c6f87db8 的时间线：
//   00:40  #10 人类消息「测试」→ #35 回答 v1
//   08:01  ↻ 裸 regen（marker #42 replace [10,35]）→ 重发 #48 → 回答 v2 #53
//   11:38  ↶ 回退（marker #57 replace [48,53]）→ 重新提问 #63 → 回答 #69
// 事故：回退后 #53 的回答（08:01 那条）仍然显示。
// 根因：RewindVisibilityBuilder.deriveOne 用 base.anchorSeq 定位节点，但宿主
// assistant-step 的 data 上只有 finalNode.seq；且旧模型把「最后一版区间」默认
// 设为可见。两者叠加 → cut 区间套不住回答行。
//
// 本测试从 client.js 抽出 RewindVisibilityBuilder（与真实宿主节点形状一致），
// 断言：deriveOne 之后区间内的旧节点 hidden、区间外的新节点 visible。
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = await readFile(join(root, 'lib', 'client.js'), 'utf8')

function grab(name) {
  const start = src.indexOf('function ' + name)
  if (start < 0) throw new Error(name + ' not found')
  let depth = 0
  let i = src.indexOf('{', start)
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}
function grabClass(name) {
  const start = src.indexOf('var ' + name + ' = class')
  if (start < 0) throw new Error(name + ' not found')
  let depth = 0
  let i = src.indexOf('{', start)
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}

// builder 依赖的最小符号集
const consts = `
var ENGINE_COMMAND = "rewind-plugin";
var LEGACY_ENGINE_COMMAND = "rewind";
var ENGINE_COMMANDS = new Set([ENGINE_COMMAND, LEGACY_ENGINE_COMMAND]);
var REGEN_COMMAND = "regen";
var RESEND_RPC_ID = "dsh-any-rollback";
var EMPTY_NODES = [];
var __publicField = (obj, key, value) => { obj[key] = value; return value };
`
const helpers = [
  'targetSeqOfArgs', 'isPreviewCommand', 'isCandidateCommand',
  'rewindCutsOf', 'bareRegenTargetOf', 'annotateVersionCuts',
  'isAnchorVisibleInCut', 'turnOf', 'changed', 'hidden',
  'nodeAnchorSeqOf', 'chatNodesOf',
].map(grab).join('\n')
const factory = new Function(
  consts + helpers + '\n' + grabClass('RewindVisibilityBuilder') +
  '\nreturn { RewindVisibilityBuilder }'
)
const { RewindVisibilityBuilder } = factory()

let pass = 0, fail = 0
const check = (ok, label, detail = '') => {
  if (ok) { pass++; console.log('  ok   ' + label) }
  else { fail++; console.log('  FAIL ' + label + (detail ? ` — ${detail}` : '')) }
}

// ── 宿主真实节点形状 ──
// turn 必须按真实轮次传入：宿主的 turn-process 汇总行靠 byTurn 判定
// （同轮成员全隐藏则汇总行隐藏），成员被错误地塞进同一 turn 会让判定失真。
const userNode = (key, seq, turn = 1, rpcId = 'u-' + seq) => ({
  key, kind: 'user', anchorSeq: seq, location: { turn: { turn } },
  data: { seq, time: 0, content: [{ type: 'text', text: 'msg-' + seq }], source: { kind: 'user', rpcId } },
})
const resendNode = (key, seq, turn = 2) => userNode(key, seq, turn, 'dsh-any-rollback')
// assistant-step：data 上没有 seq，seq 在 finalNode 上（事故根因之一）
const assistantStep = (key, seq, turn, step) => ({
  key, kind: 'assistant-step', anchorSeq: seq,
  location: { turn: { turn } },
  data: { status: 'settled', turn, step, blocks: [], time: 0, finalNode: { seq, messageId: 'm-' + seq } },
})
const commandNode = (key, seq, name, args, marker) => ({
  key, kind: 'command', anchorSeq: seq, location: { turn: { turn: 9 } },
  data: { kind: 'command', seq, time: 0, commandId: 'cmd-' + seq, name, args,
    outcome: marker === void 0 ? { kind: 'error', text: 'x' } : { kind: 'success', text: 'ok', sourceEventSeq: marker } },
})
const markerNode = (key, seq) => ({
  key, kind: 'user', anchorSeq: seq, location: { turn: { turn: 9 } },
  data: { seq, time: 0, content: [{ type: 'text', text: '(empty message)' }], source: { kind: 'dsh-rewind' } },
})

// inner builder：记录最近一次 replace/apply 的节点
const inner = {
  empty: false,
  lastNodes: [],
  replace(input) { this.lastNodes = input.nodes; return input },
  apply(input) {
    const byKey = new Map(this.lastNodes.map((n) => [n.key, n]))
    for (const n of input.upserts) byKey.set(n.key, n)
    this.lastNodes = [...byKey.values()]
    return input
  },
}

console.log('1) 事故复现：11:38 的回退后，08:01 的回答必须消失')
{
  const builder = new RewindVisibilityBuilder(inner, 's1')
  // 全量节点 = 真实会话在浏览器节点仓库里的完整集合（宿主 surface 已裁剪，
  // 但客户端仓库保留旧行 —— 这正是本层的存在理由）
  const nodes = [
    userNode('u10', 10),
    assistantStep('a35', 35, 1, 2),   // 回答 v1
    commandNode('c41', 41, 'regen', '', 42),  // 08:01 裸 regen → marker 42
    markerNode('mk42', 42),
    resendNode('u48', 48),            // 插件重发的提示
    assistantStep('a53', 53, 2, 1),   // 回答 v2 ← 截图里「没有消失」的那条
    commandNode('c56', 56, 'rewind-plugin', ' @48 chat', 57),  // 11:38 ↶ → marker 57
    markerNode('mk57', 57),
    userNode('u63', 63),
    assistantStep('a69', 69, 3, 1),   // 回答 v3（当前）
  ]
  builder.replace({ nodes, timeline: [] })
  const vis = new Map(inner.lastNodes.map((n) => [n.key, n.visibility ?? 'visible']))
  // 回退 cut = [48, 57]；regen cut = [10, 42]
  check(vis.get('a53') === 'hidden', '08:01 的回答 #53 隐藏（事故主断言）', vis.get('a53'))
  check(vis.get('u48') === 'hidden', '重发提示 #48 隐藏', vis.get('u48'))
  check(vis.get('c56') === 'hidden', '回退命令节点隐藏', vis.get('c56'))
  check(vis.get('mk57') === 'hidden', '回退标记节点隐藏', vis.get('mk57'))
  check(vis.get('u63') === 'visible', '重新提问 #63 可见', vis.get('u63'))
  check(vis.get('a69') === 'visible', '当前回答 #69 可见', vis.get('a69'))
  // 裸 regen 的 cut = [10, 42] 也推导出来了：v1 旧行同样隐藏
  check(vis.get('u10') === 'hidden', '原始提示 #10 隐藏（裸 regen 区间推导成功）', vis.get('u10'))
  check(vis.get('a35') === 'hidden', '回答 v1 #35 隐藏', vis.get('a35'))
  check(vis.get('c41') === 'hidden', 'regen 命令节点隐藏', vis.get('c41'))
}

console.log('2) 切到 v1：08:01 之前的原始轮重新可见')
{
  const builder = new RewindVisibilityBuilder(inner, 's2')
  const nodes = [
    userNode('u10', 10),
    assistantStep('a35', 35, 1, 2),
    commandNode('c41', 41, 'regen', '', 42),
    markerNode('mk42', 42),
    resendNode('u48', 48),
    assistantStep('a53', 53, 2, 1),
  ]
  builder.replace({ nodes, timeline: [] })
  // fixture 只有一次 regen（cut = [10,42]），#53 在区间外、未被撤下 → 保持可见
  builder.setSelectedVersion(1)
  const vis = new Map(inner.lastNodes.map((n) => [n.key, n.visibility ?? 'visible']))
  check(vis.get('u10') === 'visible', '切到 v1：提示词 #10 可见', vis.get('u10'))
  check(vis.get('a35') === 'visible', '切到 v1：回答 v1 可见', vis.get('a35'))
  check(vis.get('a53') === 'visible', '区间外的后续内容不受版本选择影响', vis.get('a53'))
  // 复位到最新视图
  builder.setSelectedVersion(void 0)
  const vis2 = new Map(inner.lastNodes.map((n) => [n.key, n.visibility ?? 'visible']))
  check(vis2.get('a35') === 'hidden', '复位：回答 v1 重新隐藏', vis2.get('a35'))
}

console.log('3) 无任何回退/重生成的普通会话：一切可见')
{
  const builder = new RewindVisibilityBuilder(inner, 's3')
  const nodes = [userNode('u1', 10), assistantStep('a1', 14, 1, 1)]
  builder.replace({ nodes, timeline: [] })
  const vis = new Map(inner.lastNodes.map((n) => [n.key, n.visibility ?? 'visible']))
  check(vis.get('u1') === 'visible' && vis.get('a1') === 'visible', '普通会话不受影响')
}

console.log('4) 增量 apply 路径：新命令落盘后旧行立即隐藏')
{
  const builder = new RewindVisibilityBuilder(inner, 's4')
  const nodes = [userNode('u10', 10), assistantStep('a14', 14, 1, 1)]
  builder.replace({ nodes, timeline: [] })
  const vis0 = new Map(inner.lastNodes.map((n) => [n.key, n.visibility ?? 'visible']))
  check(vis0.get('a14') === 'visible', '回退前：回答可见')
  // 新的回退命令 + 标记 + 重新提问到达
  builder.apply({ upserts: [
    commandNode('c20', 20, 'rewind-plugin', ' @10 chat', 21),
    markerNode('mk21', 21),
  ], timeline: [] })
  const vis1 = new Map(inner.lastNodes.map((n) => [n.key, n.visibility ?? 'visible']))
  check(vis1.get('a14') === 'hidden', '回退落盘后：旧回答立即隐藏', vis1.get('a14'))
}

console.log('5) 截图残留回归：turn-process 汇总行必须随轮次一起隐藏')
{
  // 「已完成，用时 N 秒」= turn-process 行，锚点是轮次控制位（turn/start 或
  // 最早的轮次事件），∈ cut 区间内 → 必须隐藏。截图里它曾整段留在上面。
  const builder = new RewindVisibilityBuilder(inner, 's5')
  const turnProcess = (key, seq, turn) => ({
    key, kind: 'turn-process', anchorSeq: seq,
    location: { turn: { turn } },
    data: { controlAnchorSeq: seq, turn, messageCount: 1, toolCallCount: 0, subagentCount: 0 },
  })
  // 真实时间线：turn 1 被裸 regen [10,42] 撤下，turn 2 被 @48 回退 [48,57] 撤下，
  // turn 3 是当前轮。
  const nodes = [
    turnProcess('p1', 6, 1), userNode('u10', 10, 1), assistantStep('a35', 35, 1, 1),
    commandNode('c41', 41, 'regen', '', 42), markerNode('mk42', 42),
    turnProcess('p2', 44, 2), resendNode('u48', 48, 2), assistantStep('a53', 53, 2, 1),
    commandNode('c56', 56, 'rewind-plugin', ' @48 chat', 57),
    markerNode('mk57', 57),
    turnProcess('p3', 77, 3), userNode('u80', 80, 3), assistantStep('a85', 85, 3, 1),
  ]
  builder.replace({ nodes, timeline: [] })
  const vis = new Map(inner.lastNodes.map((n) => [n.key, n.visibility ?? 'visible']))
  check(vis.get('p1') === 'hidden', 'turn 1 的「已完成」行隐藏', vis.get('p1'))
  check(vis.get('u10') === 'hidden', 'turn 1 的提示词隐藏', vis.get('u10'))
  check(vis.get('a35') === 'hidden', 'turn 1 的回答隐藏', vis.get('a35'))
  check(vis.get('p2') === 'hidden', 'turn 2 的「已完成」行隐藏', vis.get('p2'))
  check(vis.get('p3') === 'visible', '当前轮 turn 3 的「已完成」行可见', vis.get('p3'))
}

console.log('6) 截图残留回归：失败的回退/重生成命令行也要隐藏')
{
  // 截图里的 `regen · fs is not defined`：command/done 是 error，没有 sourceEventSeq，
  // 既不算 cut 源、也进不了「已执行」判定 —— 必须按名字 + error 一并隐藏。
  const builder = new RewindVisibilityBuilder(inner, 's6')
  const failed = (key, seq, name, args) => ({
    key, kind: 'command', anchorSeq: seq, location: { turn: { turn: 1 } },
    data: { kind: 'command', seq, time: 0, commandId: 'cmd-' + seq, name, args, outcome: { kind: 'error', text: 'fs is not defined' } },
  })
  const nodes = [
    userNode('u10', 10),
    failed('c38', 38, 'regen', ''),
    assistantStep('a35', 35, 1, 1),
    commandNode('c56', 56, 'rewind-plugin', ' @10 chat', 57),
    markerNode('mk57', 57),
  ]
  builder.replace({ nodes, timeline: [] })
  const vis = new Map(inner.lastNodes.map((n) => [n.key, n.visibility ?? 'visible']))
  check(vis.get('c38') === 'hidden', '失败的 regen 命令行隐藏（截图残留项）', vis.get('c38'))
}

console.log('7) 截图残留回归：turn-process 的合成锚点（小数）也要被区间命中')
{
  // 宿主 turn-process 的 anchorSeq = controlAnchorSeq + CHAT_SYNTHETIC_SEQ_OFFSETS
  // .processControl（-0.1），即 5.9 这种**小数**。旧 nodeAnchorSeqOf 用
  // Number.isSafeInteger 判断 anchorSeq，小数被拒 → 返回 undefined →
  // deriveOne 直接放过该行。「已完成，用时 N 秒」正是这样留在屏幕上的。
  const builder = new RewindVisibilityBuilder(inner, 's7')
  const fractionalProcess = (key, controlSeq, turn) => ({
    key, kind: 'turn-process',
    anchorSeq: controlSeq - 0.1, // 小数锚点，真实宿主的取值
    location: { turn: { turn } },
    data: { controlAnchorSeq: controlSeq, turn, messageCount: 1, toolCallCount: 0, subagentCount: 0 },
  })
  const nodes = [
    fractionalProcess('p1', 6, 1), userNode('u10', 10, 1), assistantStep('a35', 35, 1, 1),
    commandNode('c56', 56, 'rewind-plugin', ' @10 chat', 57),
    markerNode('mk57', 57),
    // 回退点之后的轮次：锚点 63.9 / 69 都 > marker 57，不在任何区间内
    fractionalProcess('p2', 63, 2), userNode('u70', 70, 2), assistantStep('a75', 75, 2, 1),
  ]
  builder.replace({ nodes, timeline: [] })
  const vis = new Map(inner.lastNodes.map((n) => [n.key, n.visibility ?? 'visible']))
  check(vis.get('p1') === 'hidden', '小数锚点的「已完成」行隐藏（5.9 归到 5，同轮成员全隐藏 → 汇总行隐藏）', vis.get('p1'))
  check(vis.get('p2') === 'visible', '当前轮的小数锚点行可见', vis.get('p2'))
}

console.log('')
console.log(fail === 0 ? `全部通过（${pass} 项）` : `失败 ${fail} 项 / 共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)
