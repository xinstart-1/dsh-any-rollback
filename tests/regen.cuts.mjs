// 用真实会话日志验证「重新生成后旧记录消失」的修复：
// 从 client.js 抽出 rewindCutsOf / targetSeqOfArgs 等纯函数，喂真实形状的 chat 节点，
// 断言 /regen 命令也能推导出 {target, marker} 区间。
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = await readFile(join(root, 'lib', 'client.js'), 'utf8')

// 抽取函数源码（括号配平）
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

const consts = `
var ENGINE_COMMAND = "rewind-plugin";
var LEGACY_ENGINE_COMMAND = "rewind";
var ENGINE_COMMANDS = new Set([ENGINE_COMMAND, LEGACY_ENGINE_COMMAND]);
var REGEN_COMMAND = "regen";
var RESEND_RPC_ID = "dsh-any-rollback";
`
const helpers = ['targetSeqOfArgs', 'isPreviewCommand', 'isCandidateCommand', 'rewindCutsOf', 'bareRegenTargetOf'].map(grab).join('\n')

const factory = new Function(consts + helpers + '\nreturn { rewindCutsOf, targetSeqOfArgs, REGEN_COMMAND, ENGINE_COMMANDS }')
const { rewindCutsOf, targetSeqOfArgs, REGEN_COMMAND, ENGINE_COMMANDS } = factory()

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) { pass++; console.log('  ok   ' + label) }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')) }
}

// 真实形状的命令节点：宿主 conversation-nodes/command.js 构造
const commandNode = (seq, name, args, outcome) => ({
  kind: 'command',
  anchorSeq: seq,
  data: { kind: 'command', seq, time: 0, commandId: 'cmd-' + seq, name, args, outcome },
})
// 真实形状的人类用户消息节点（宿主 chatNode：anchorSeq = data.seq）
const userNode = (seq, rpcId = 'user-rpc-1') => ({
  kind: 'user',
  anchorSeq: seq,
  data: { seq, time: 0, content: [{ type: 'text', text: 'msg-' + seq }], source: { kind: 'user', rpcId } },
})
// 插件自己重发的提示（rpcId = dsh-any-rollback），不算「人类消息」
const resendNode = (seq) => userNode(seq, 'dsh-any-rollback')

console.log('1) 真实日志里的那次 /regen（name=regen, args="", sourceEventSeq=42）')
{
  // 裸 /regen：宿主的空输入语义是「重发最新一条人类用户消息」。
  // 只有命令节点、没有人类消息 → 推断不出目标 → 必须不产生区间。
  const nodes = [commandNode(41, 'regen', '', { kind: 'success', sourceEventSeq: 42 })]
  const cuts = rewindCutsOf(nodes)
  check(cuts.length === 0, '无人类消息可推断 → 不产生区间（宁可不隐藏，也不能隐藏错范围）', JSON.stringify(cuts))
}

console.log('2) 带目标 seq 的 /regen（修复后按钮会发 " @10"）')
{
  const nodes = [commandNode(41, 'regen', ' @10', { kind: 'success', sourceEventSeq: 42 })]
  const cuts = rewindCutsOf(nodes)
  check(cuts.length === 1, '产生 1 个遮蔽区间', JSON.stringify(cuts))
  check(cuts[0]?.target === 10 && cuts[0]?.marker === 42, '区间 = [10, 42]', JSON.stringify(cuts[0]))
}

console.log('3) 引擎命令（/rewind）仍然工作，不回归')
{
  const nodes = [commandNode(596, 'rewind-plugin', ' @585 chat', { kind: 'success', sourceEventSeq: 597 })]
  const cuts = rewindCutsOf(nodes)
  check(cuts.length === 1 && cuts[0].target === 585 && cuts[0].marker === 597, '/rewind 区间 = [585,597]', JSON.stringify(cuts))
}

console.log('4) 预览/候选探针命令不产生区间')
{
  const nodes = [
    commandNode(100, 'rewind-plugin', ' @10 preview', { kind: 'success', sourceEventSeq: 101 }),
    commandNode(102, 'rewind-plugin', ' @10 __candidates', { kind: 'success', sourceEventSeq: 103 }),
  ]
  const cuts = rewindCutsOf(nodes)
  check(cuts.length === 0, '探针命令被排除', JSON.stringify(cuts))
}

console.log('5) 失败命令 / 无 marker / target>marker 都不产生区间')
{
  const nodes = [
    commandNode(38, 'regen', ' @10', { kind: 'error', text: 'fs is not defined' }),
    commandNode(41, 'regen', ' @10', { kind: 'success' }),
    commandNode(50, 'regen', ' @60', { kind: 'success', sourceEventSeq: 51 }),
  ]
  const cuts = rewindCutsOf(nodes)
  check(cuts.length === 0, '失败/无 marker/越界都被排除', JSON.stringify(cuts))
}

console.log('6) 多个版本叠加：每次 regenerate 各产生一个区间')
{
  const nodes = [
    commandNode(41, 'regen', ' @10', { kind: 'success', sourceEventSeq: 42 }),
    commandNode(60, 'regen', ' @10', { kind: 'success', sourceEventSeq: 61 }),
  ]
  const cuts = rewindCutsOf(nodes)
  check(cuts.length === 2, '两个区间', JSON.stringify(cuts))
  check(cuts.every((c) => c.target === 10), '两个区间都以 #10 为回退点')
  check(cuts[1].marker === 61 && cuts[0].marker === 42, 'marker 各自不同')
}

console.log('7) 非命令节点被忽略')
{
  const nodes = [
    { kind: 'user', anchorSeq: 10, data: { seq: 10 } },
    { kind: 'assistant', anchorSeq: 14, data: { seq: 14, messageId: 'm1' } },
  ]
  check(rewindCutsOf(nodes).length === 0, '非命令节点不产生区间')
}

console.log('8) 裸 /regen：目标推断镜像宿主 latestUserSeqOf（真实日志 session-0a61f77f 形状）')
{
  // 真实时间线：#10 人类消息「测试」→ 回答 #35 → 08:01 裸 regen（marker #42）
  // → 重发提示 #48（rpcId=dsh-any-rollback）→ 回答 #53。
  // 旧实现推不出 target → 无区间 → #53 在随后的回退后仍然显示。
  const nodes = [
    userNode(10),
    { kind: 'assistant-step', anchorSeq: 35, data: { turn: 1, step: 2, finalNode: { seq: 35, messageId: 'm1' } } },
    commandNode(41, 'regen', '', { kind: 'success', sourceEventSeq: 42 }),
    resendNode(48),
    { kind: 'assistant-step', anchorSeq: 53, data: { turn: 2, step: 1, finalNode: { seq: 53, messageId: 'm2' } } },
  ]
  const cuts = rewindCutsOf(nodes)
  check(cuts.length === 1, '裸 regen 推断出 1 个区间', JSON.stringify(cuts))
  check(cuts[0]?.target === 10 && cuts[0]?.marker === 42, '区间 = [10, 42]（目标 = 最新人类消息）', JSON.stringify(cuts[0]))
}

console.log('9) 裸 /regen：上一次 regen 的重发提示不算目标')
{
  // 真实场景：第一次裸 regen（marker 42）重发的提示 #48（rpcId 命中），
  // 第二次裸 regen（marker 56）的目标必须是 #10，而不是 #48。
  const nodes = [
    userNode(10),
    commandNode(41, 'regen', '', { kind: 'success', sourceEventSeq: 42 }),
    resendNode(48),
    { kind: 'assistant-step', anchorSeq: 53, data: { turn: 2, step: 1, finalNode: { seq: 53, messageId: 'm2' } } },
    commandNode(55, 'regen', '', { kind: 'success', sourceEventSeq: 56 }),
  ]
  const cuts = rewindCutsOf(nodes)
  check(cuts.length === 2, '两次裸 regen 各一个区间', JSON.stringify(cuts))
  check(cuts[0]?.target === 10 && cuts[1]?.target === 10, '两个目标都是 #10（跳过重发提示 #48）', JSON.stringify(cuts))
}

console.log('9b) 裸 /regen：运行时注入（runtime-context 等）不算目标')
{
  // 注入消息 kind 也是 user/steering，但 source.kind 不是 'user' → 跳过
  const nodes = [
    userNode(10),
    commandNode(41, 'regen', '', { kind: 'success', sourceEventSeq: 42 }),
    { kind: 'steering', anchorSeq: 44, data: { seq: 44, source: { kind: 'runtime-context' } } },
    { kind: 'steering', anchorSeq: 45, data: { seq: 45, source: { kind: 'skill-catalog' } } },
    { kind: 'steering', anchorSeq: 46, data: { seq: 46, source: { kind: 'time-context' } } },
  ]
  const cuts = rewindCutsOf(nodes)
  check(cuts.length === 1 && cuts[0]?.target === 10, '目标 = #10（注入消息被排除）', JSON.stringify(cuts))
}

console.log('10) 带显式 @seq 的 regen 不做推断')
{
  const nodes = [userNode(10), userNode(20), commandNode(41, 'regen', ' @10', { kind: 'success', sourceEventSeq: 42 })]
  const cuts = rewindCutsOf(nodes)
  check(cuts.length === 1 && cuts[0]?.target === 10, '显式目标优先', JSON.stringify(cuts))
}

console.log('')
console.log(fail === 0 ? `全部通过（${pass} 项）` : `失败 ${fail} 项 / 共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)