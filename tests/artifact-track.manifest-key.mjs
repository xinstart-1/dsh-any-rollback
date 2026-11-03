#!/usr/bin/env node
// 回归：产物清单 key 必须等于「这一轮的人类提示词 seq」。
//
// 真实事故（session-0a61f77f）：用户只打了一句「测试」就回退，却看到 5 个无关文件
// 被列进删除清单。根因链：
//   1) onTurnEnd 取「最后一条 user/message」当 key，实际拿到的是运行时注入消息
//      （runtime-context / time-context / skill-catalog），它们的 seq 比提示词大。
//      真实会话里 key 落成 [0,42,51,74,83]，而轮次起点是 [10,48,63,80]。
//   2) 回退到 63 时 stateAt 找不到 key<63 的最新清单，退化到 51（5 小时前）。
//   3) plan() 按「清单里没有 = 新建产物」判定，把中间所有文件都列成待删除。
//
// 本测试锁定第 1 步：key 必须落在人类提示词上，且与 /rewind 的候选语义一致。
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = await readFile(join(root, 'lib', 'index.js'), 'utf8')

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

const factory = new Function(
  grab('isUserMessageEvent') + '\n' + grab('isHumanUserMessageEvent') + '\n' +
  grab('turnStartSeqsOf') + '\n' +
  'return { turnStartSeqsOf, isHumanUserMessageEvent }',
)
const { turnStartSeqsOf, isHumanUserMessageEvent } = factory()

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) { pass++; console.log('  ok   ' + label) }
  else { fail++; console.log('  FAIL ' + label + (detail ? ` — ${detail}` : '')) }
}

// ── 真实会话的轮次形状（session-0a61f77f）──
// turn 1: start 6 → 人类提示 #10，随后注入 #11/#12/#13 → 回答 #35
// turn 2: start 44 → 重发提示 #48（rpcId=dsh-any-rollback，也是 kind:'user'）→ #49-51 注入
// turn 3: start 60 → 提示 #63 → 注入 #64-66
// turn 4: start 77 → 提示 #80 → 注入 #81-83
const ev = (type, seq, source) => ({
  type,
  seq,
  data: source === undefined ? {} : { source },
})
const human = (seq) => ev('user/message', seq, { kind: 'user', rpcId: 'u-' + seq })
const resend = (seq) => ev('user/message', seq, { kind: 'user', rpcId: 'dsh-any-rollback' })
const injected = (seq, kind) => ev('user/message', seq, { kind })
const marker = (seq) => ev('user/message', seq, { kind: 'dsh-rewind' })

const events = [
  ev('turn/start', 6), human(10), injected(11, 'runtime-context'), injected(12, 'skill-catalog'),
  injected(13, 'time-context'), ev('tool/call', 20), ev('tool/result', 24),
  ev('assistant/message', 25),
  // turn 1 里的第二条 assistant 消息之前，宿主又注入了上下文与审批消息
  ev('user/message', 33, { kind: 'user-approval' }), ev('user/message', 34, { kind: 'runtime-context' }),
  ev('assistant/message', 35), ev('turn/end', 37),
  ev('turn/start', 44), resend(48), injected(49, 'runtime-context'), injected(50, 'skill-catalog'),
  injected(51, 'time-context'), ev('assistant/message', 53), ev('turn/end', 55),
  ev('turn/start', 60), human(63), injected(64, 'runtime-context'), injected(65, 'skill-catalog'),
  injected(66, 'time-context'), ev('assistant/message', 69), ev('turn/end', 71),
  marker(74),
  ev('turn/start', 77), human(80), injected(81, 'runtime-context'), injected(82, 'skill-catalog'),
  injected(83, 'time-context'), ev('assistant/message', 85), ev('turn/end', 87),
]

const session = { snapshotEvents: () => events.slice() }

console.log('1) 轮次起点 = 人类提示词 seq（不是注入消息）')
{
  const starts = turnStartSeqsOf(session)
  check(
    JSON.stringify(starts) === JSON.stringify([10, 48, 63, 80]),
    'turnStartSeqsOf = [10,48,63,80]',
    JSON.stringify(starts),
  )
}

console.log('2) 对照：旧实现「最后一条 user/message」会取到什么')
{
  // 复刻旧逻辑，证明偏差真实存在
  const naive = []
  for (let i = 0; i < events.length; i++) {
    if (events[i].type !== 'turn/end') continue
    let key = 0
    for (let j = i; j >= 0; j--) {
      if (events[j].type === 'user/message') { key = events[j].seq; break }
    }
    naive.push(key)
  }
  check(
    JSON.stringify(naive) === JSON.stringify([34, 51, 66, 83]),
    '旧实现取到注入消息的 seq（34/51/66/83，与回退目标错位）',
    JSON.stringify(naive),
  )
  const starts = turnStartSeqsOf(session)
  check(
    naive.every((key) => !starts.includes(key)),
    '旧 key 与轮次起点完全不重合 —— 这就是回退对不上清单的根因',
    `naive=${JSON.stringify(naive)} starts=${JSON.stringify(starts)}`,
  )
}

console.log('3) 注入消息与遮蔽标记都不算人类提示词')
{
  check(isHumanUserMessageEvent(human(100)) === true, 'kind=user 的人类消息算')
  check(isHumanUserMessageEvent(resend(101)) === true, '插件重发的提示也算（回退目标就是它）')
  check(isHumanUserMessageEvent(injected(102, 'runtime-context')) === false, 'runtime-context 不算')
  check(isHumanUserMessageEvent(injected(103, 'time-context')) === false, 'time-context 不算')
  check(isHumanUserMessageEvent(injected(104, 'skill-catalog')) === false, 'skill-catalog 不算')
  check(isHumanUserMessageEvent(marker(105)) === false, '遮蔽标记（dsh-rewind）不算')
}

console.log('4) 回退目标能在轮次起点里命中')
{
  const starts = turnStartSeqsOf(session)
  for (const target of [10, 48, 63, 80]) {
    check(starts.includes(target), `回退目标 #${target} 有对应清单 key`)
  }
}

console.log('')
console.log(fail === 0 ? `全部通过（${pass} 项）` : `失败 ${fail} 项 / 共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)
