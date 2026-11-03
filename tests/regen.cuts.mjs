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
`
const helpers = ['targetSeqOfArgs', 'isPreviewCommand', 'isCandidateCommand', 'rewindCutsOf'].map(grab).join('\n')

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

console.log('1) 真实日志里的那次 /regen（name=regen, args="", sourceEventSeq=42）')
{
  // 空 args 时无法确定 target —— 必须不产生区间（宁可不隐藏，也不能隐藏错范围）
  const nodes = [commandNode(41, 'regen', '', { kind: 'success', sourceEventSeq: 42 })]
  const cuts = rewindCutsOf(nodes)
  check(cuts.length === 0, '空 args 不产生区间（避免隐藏错范围）', JSON.stringify(cuts))
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

console.log('')
console.log(fail === 0 ? `全部通过（${pass} 项）` : `失败 ${fail} 项 / 共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)