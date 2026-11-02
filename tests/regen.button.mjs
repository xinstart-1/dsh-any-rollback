#!/usr/bin/env node
// 回归：↻ 按钮的「回复 → 用户提示」映射方向必须正确（向前回溯）。
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = await readFile(join(root, 'lib', 'client.js'), 'utf8')

// 从产物中提取两个纯函数并求值（它们不依赖运行时上下文）
const grab = (name) => {
  const s = src.indexOf('function ' + name)
  if (s < 0) throw new Error(name + ' not found')
  let depth = 0, i = src.indexOf('{', s)
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(s, i + 1)
}
// chatNodesOf 也在产物里，注入以便两个函数可用
const helperSrc = grab('assistantSeqOfMessage') + '\n' + grab('userSeqBeforeReply')
const chatNodesOf = (chat) => {
  if (chat === void 0) return []
  const values = chat.nodes.values
  if (typeof values === 'function') return [...values.call(chat.nodes)]
  const out = []
  for (const key of chat.order) { const n = chat.nodes.get(key); if (n !== void 0) out.push(n) }
  return out
}
const factory = new Function('chatNodesOf', helperSrc + '\nreturn { assistantSeqOfMessage, userSeqBeforeReply }')
const { assistantSeqOfMessage, userSeqBeforeReply } = factory(chatNodesOf)

let pass = 0, fail = 0
const check = (ok, label, detail = '') => {
  if (ok) { pass++; console.log('  ok   ' + label) }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')) }
}

const N = (key, kind, seq, messageId) => ({ key, kind, data: { seq, messageId } })
const nodes = new Map([
  ['u10', N('u10', 'user', 10)],
  ['a14', N('a14', 'assistant', 14, 'm1')],
  ['u20', N('u20', 'user', 20)],
  ['a24', N('a24', 'assistant', 24, 'm2')],
  ['u30', N('u30', 'user', 30)],
  ['a34', N('a34', 'assistant', 34, 'm3')],
])
const chat = { nodes, order: ['u10', 'a14', 'u20', 'a24', 'u30', 'a34'] }

console.log('1) 回复 → 触发它的用户消息（必须向前回溯）')
check(userSeqBeforeReply(chat, 14) === 10, '第1条回复(14) → user@10', String(userSeqBeforeReply(chat, 14)))
check(userSeqBeforeReply(chat, 24) === 20, '第2条回复(24) → user@20', String(userSeqBeforeReply(chat, 24)))
check(userSeqBeforeReply(chat, 34) === 30, '第3条回复(34) → user@30', String(userSeqBeforeReply(chat, 34)))

console.log('2) messageId → 回复节点 seq')
check(assistantSeqOfMessage(chat, 'm1') === 14, 'm1 → 14')
check(assistantSeqOfMessage(chat, 'm2') === 24, 'm2 → 24')
check(assistantSeqOfMessage(chat, 'nope') === void 0, '未知 messageId → undefined')

console.log('3) 边界：首条回复前无用户消息')
{
  const single = { nodes: new Map([['a1', N('a1', 'assistant', 5, 'x')]]), order: ['a1'] }
  check(userSeqBeforeReply(single, 5) === void 0, '无前置用户消息时返回 undefined')
}
console.log('4) 边界：中间夹着 steering 节点')
{
  const withSteer = {
    nodes: new Map([
      ['u1', N('u1', 'user', 10)],
      ['s1', N('s1', 'steering', 12)],
      ['a1', N('a1', 'assistant', 14, 'k')],
    ]),
    order: ['u1', 's1', 'a1'],
  }
  check(userSeqBeforeReply(withSteer, 14) === 12, '命中最近的 steering', String(userSeqBeforeReply(withSteer, 14)))
}

console.log('')
console.log(fail === 0 ? `全部通过（${pass} 项）` : `失败 ${fail} 项 / 共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)
