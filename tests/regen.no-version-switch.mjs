// 回归：版本切换控件已被移除，只显示最新版。
//
// 背景：纯前端「显示旧版」与宿主模型上下文必然脱节（切到旧版后继续提问，模型
// 仍按最新版回答）。用户决定去掉这个能力，只保留「回退/重生成后撤下的旧内容隐藏」。
// 本测试钉死三件事：
//   1. 不再注册 `conversation.chat.assistant-actions` 的 regen-versions 条目；
//   2. 相关实现（版本状态 / 分页 / 重绘 / RPC）已彻底删除，不留死代码；
//   3. 保留的可见性逻辑仍然只显示最新版（撤下的内容隐藏）。
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = await readFile(join(root, 'lib', 'client.js'), 'utf8')

let pass = 0, fail = 0
const check = (ok, label, detail = '') => {
  if (ok) { pass++; console.log('  ok   ' + label) }
  else { fail++; console.log('  FAIL ' + label + (detail ? ` — ${detail}` : '')) }
}

console.log('1) 版本切换条目不再注册')
{
  check(!src.includes('regen-versions'), '没有 regen-versions 条目 id')
  check(!src.includes('AssistantVersionSwitcher'), '没有 AssistantVersionSwitcher 组件')
  check(!src.includes('versionGroupOf'), '注入面不再暴露 versionGroupOf')
  check(!src.includes('usePages'), '组件不再订阅 usePages')
  check(!src.includes('props.selectVersion'), '组件不再调用 selectVersion')
}

console.log('2) 相关实现已彻底删除（不留死代码）')
{
  const dead = [
    'createVersionState', 'sameSelections', 'versionStateFor', 'versionStates',
    'selectVersionFor', 'repaintSession', 'healSessionBuilder', 'liveBuilders',
    'buildingSessionId', 'selectedPages', 'readSelection', 'spanSignature',
    'versionGroupsForChat', 'versionGroupsCache', 'humanUserSeqsOf',
    'versionGroupsOf', 'groupAtAnchor', 'isAnchorVisibleInGroup',
    'selectVersionPages', 'versionPagesCache',
    'versionsOverRpc', 'isVersion',
  ]
  for (const name of dead) {
    check(!src.includes(name), `已删除 ${name}`)
  }
}

console.log('3) 相关 CSS 与 i18n 键一并清掉')
{
  check(!src.includes('dsh-rewind-versions'), '版本控件 CSS 类已移除')
  check(!src.includes('regen.versionLabel'), '版本标签文案已移除')
  check(!src.includes('regen.versionPrev'), '上一版文案已移除')
  check(!src.includes('regen.versionNext'), '下一版文案已移除')
}

console.log('4) 保留的能力：↻ 重新生成按钮仍在')
{
  check(src.includes('AssistantRegenButton'), '↻ 按钮组件仍在')
  check(src.includes('session.command("/regen" + arg)'), '仍能发起 /regen')
  check(src.includes('id: "regen"'), 'regen 条目仍注册')
}

console.log('5) 保留的能力：撤下的旧内容仍然隐藏（只显示最新版）')
{
  function grab(name) {
    const start = src.indexOf('function ' + name)
    if (start < 0) throw new Error(name + ' not found')
    let depth = 0, i = src.indexOf('{', start)
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
var EMPTY_NODES = [];
var rewindLog = { info() {}, warn() {}, error() {} };
var __publicField = (o, k, v) => { o[k] = v; return v };
`
  const helpers = [
    'targetSeqOfArgs', 'isPreviewCommand', 'isCandidateCommand', 'rewindCutsOf',
    'bareRegenTargetOf', 'turnOf', 'changed', 'hidden', 'nodeAnchorSeqOf', 'chatNodesOf',
  ].map(grab).join('\n')
  // 抓 class 源码
  const cs = src.indexOf('var RewindVisibilityBuilder = class')
  let depth = 0, k = src.indexOf('{', cs)
  for (; k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}') { depth--; if (depth === 0) break }
  }
  const classSrc = src.slice(cs, k + 1)
  const f = new Function(consts + helpers + '\n' + classSrc + '\nreturn { RewindVisibilityBuilder }')
  const { RewindVisibilityBuilder } = f()

  const inner = {
    empty: false, lastNodes: [],
    replace(input) { this.lastNodes = input.nodes; return input },
    apply(input) {
      const byKey = new Map(this.lastNodes.map((n) => [n.key, n]))
      for (const n of input.upserts) byKey.set(n.key, n)
      this.lastNodes = [...byKey.values()]
      return input
    },
  }
  const mk = (key, kind, seq, extra = {}) => ({
    key, kind, anchorSeq: seq,
    location: { turn: { turn: extra.turn ?? 1 } },
    visibility: 'visible',
    data: extra.data ?? { seq },
  })
  const nodes = [
    mk('u10', 'user', 10, { data: { seq: 10, content: [{ type: 'text', text: 'q' }], source: { kind: 'user', rpcId: 'r1' } } }),
    mk('a18', 'assistant-step', 18, { turn: 1, data: { status: 'settled', turn: 1, step: 1, blocks: [], finalNode: { seq: 18, messageId: 'm18' } } }),
    mk('c23', 'command', 23, { data: { kind: 'command', seq: 23, commandId: 'c1', name: 'regen', args: ' @10', outcome: { kind: 'success', sourceEventSeq: 23 } } }),
    mk('u29', 'user', 29, { turn: 2, data: { seq: 29, content: [{ type: 'text', text: 'q' }], source: { kind: 'user', rpcId: 'dsh-any-rollback' } } }),
    mk('a33', 'assistant-step', 33, { turn: 2, data: { status: 'settled', turn: 2, step: 1, blocks: [], finalNode: { seq: 33, messageId: 'm33' } } }),
    mk('u60', 'user', 60, { turn: 3, data: { seq: 60, content: [{ type: 'text', text: 'new q' }], source: { kind: 'user', rpcId: 'r3' } } }),
    mk('a66', 'assistant-step', 66, { turn: 3, data: { status: 'settled', turn: 3, step: 1, blocks: [], finalNode: { seq: 66, messageId: 'm66' } } }),
  ]
  const builder = new RewindVisibilityBuilder(inner)
  builder.replace({ nodes, timeline: [] })
  const vis = new Map(inner.lastNodes.map((n) => [n.key, n.visibility ?? 'visible']))
  check(vis.get('u10') === 'hidden', '被撤下的提问 #10 隐藏', vis.get('u10'))
  check(vis.get('a18') === 'hidden', '被撤下的回答 #18 隐藏', vis.get('a18'))
  check(vis.get('u29') === 'visible', '重发的提问 #29 可见', vis.get('u29'))
  check(vis.get('a33') === 'visible', '重生成回答 #33 可见', vis.get('a33'))
  check(vis.get('u60') === 'visible', '之后的**新提问 #60 可见**（不会被当成旧版内容藏起来）', vis.get('u60'))
  check(vis.get('a66') === 'visible', '新回答 #66 可见', vis.get('a66'))
}

console.log('')
console.log(fail === 0 ? `全部通过（${pass} 项）` : `失败 ${fail} 项 / 共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)