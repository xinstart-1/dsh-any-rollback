#!/usr/bin/env node
// 回归：回退成功后「填回输入框」必须覆盖已有内容，且不静默丢草稿。
//
// 用户实测：点 ↶ 回退到一条历史消息时，如果输入框里已经有东西，被撤回的那句
// 提示词不会填进去 —— 因为 runRewindAndFill 里有一条 `composerText().trim() !== ""`
// 的跳过判据（读的还是全局第一个 [data-composer-input]，多会话时甚至读错框）。
// README 承诺的是无条件「输入框自动填回被撤回的那句话」。
//
// 做法：从 lib/client.js 抽出真实函数源码（不是镜像实现），用 new Function 注入
// 依赖后直接调用 runRewindAndFill / setComposerText，断言：
//   1. 输入框非空时仍然覆盖（本次修复的正面用例）；
//   2. 输入框为空时同样填回（不回归）；
//   3. 回退失败 / 未匹配 / 抛异常 / 超时 → 一律不写输入框；
//   4. 非主视图会话不写输入框（多窗口下不能填错会话）；
//   5. 目标消息没有文字（纯图片）时不写文字，但图片仍然恢复；
//   6. 替换成功且原来有草稿时给出「已替换」提示；原来为空时不打扰；
//   7. 写入通道不可用时返回 false（调用方据此告警），不抛；
//   8. 目标消息文字为纯空白时按原样写入（不吞掉用户原话）。
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = await readFile(join(root, 'lib/client.js'), 'utf8')

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

// ── 抽取真实函数（括号配平；async 前缀保留）──────────────────────────────────
function grabFunction(name) {
  // 必须精确匹配 `function <name>(`：indexOf('function fillComposer') 会先命中
  // fillComposerEditable，抽错函数会让依赖链断掉（fillComposer 变成未定义）。
  const candidates = ['async function ' + name + '(', 'function ' + name + '(']
  let start = -1
  for (const needle of candidates) {
    const at = src.indexOf(needle)
    if (at >= 0 && (start < 0 || at < start)) start = at
  }
  if (start < 0) throw new Error(`${name} not found in lib/client.js`)
  let depth = 0
  let i = src.indexOf('{', start)
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}
function grabArrow(name) {
  const start = src.indexOf('const ' + name + ' = ')
  if (start < 0) throw new Error(`${name} not found in lib/client.js`)
  let depth = 0
  let i = src.indexOf('{', start)
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1).replace(/^const\s+/, '')
}

const consts = `
var ENGINE_COMMAND = "rewind-plugin";
var LEGACY_ENGINE_COMMAND = "rewind";
var ENGINE_COMMANDS = new Set([ENGINE_COMMAND, LEGACY_ENGINE_COMMAND]);
var EMPTY_NODES = [];
var rewindLog = { warn() {}, info() {}, error() {}, debug() {} };
`
const helpers = [
  'chatNodesOf',
  'targetSeqOfArgs',
  'isExecutedRewindCommand',
  'knownCommandSeqs',
  'findCommand',
  'waitForCommand',
  'messageTextAt',
  'messageAttachmentsAt',
].map(grabFunction).join('\n')

const runSource = grabFunction('runRewindAndFill')
const composerTextSource = grabFunction('composerText')
const composerSurfaceSource = grabFunction('composerSurface')
const showHintSource = grabFunction('showHint')
const writeComposerSource = grabFunction('writeComposer')
const fillComposerSource = grabFunction('fillComposer')
const fillComposerEditableSource = grabFunction('fillComposerEditable')
const setComposerTextSource = grabArrow('setComposerText')

// ── 假 DOM（showHint 会建元素并读几何）──────────────────────────────────────
// 关键：document.querySelector("[data-composer-input]") 必须真的返回一个带
// textContent 的输入框，否则修复前的 `composerText().trim() !== ""` 判据永远
// 读到空串，测试就对「输入框有内容」这一真实场景是盲的（红不了）。
const hints = []
const composerEl = {
  textContent: '',
  style: {},
  className: '',
  setAttribute() {},
  appendChild() {},
  remove() {},
  focus() { this.focused = true },
  dispatchEvent() { this.inputEvents = (this.inputEvents ?? 0) + 1 },
  closest() { return null },
  getBoundingClientRect() { return { left: 0, top: 0 } },
}
let composerPresent = true
const makeEl = () => ({
  style: {},
  className: '',
  textContent: '',
  setAttribute() {},
  appendChild() {},
  remove() { this.removed = true },
  closest() { return null },
  getBoundingClientRect() { return { left: 0, top: 0 } },
})
globalThis.document = {
  createElement: () => makeEl(),
  body: { appendChild: (el) => hints.push(el) },
  querySelector: (selector) => (selector === '[data-composer-input]' && composerPresent ? composerEl : null),
  querySelectorAll: () => [],
  execCommand: () => false,
  getSelection: () => null,
  createRange: () => ({ selectNodeContents() {} }),
}
globalThis.window = globalThis
globalThis.window.innerHeight = 1000
globalThis.Event = class Event { constructor(type) { this.type = type } }
globalThis.HTMLElement = class HTMLElement {}

const factory = new Function(
  consts + helpers + '\n' +
  runSource + '\n' +
  composerSurfaceSource + '\n' +
  composerTextSource + '\n' +
  showHintSource + '\n' +
  fillComposerEditableSource + '\n' +
  fillComposerSource + '\n' +
  writeComposerSource + '\n' +
  'var COMPOSER_EDITABLE_SELECTOR = "[data-composer-input]";\n' +
  'return { runRewindAndFill, writeComposer, composerText, showHint };',
)
const real = factory()

// setComposerText 是 apply() 里的闭包（依赖 t / composerFacade / showHint / composerText），
// 逐字使用真实源码，只把这几项依赖注入进去。
const setComposerTextFactory = new Function(
  'composerFacade', 'composerText', 'writeComposer', 'showHint', 't', 'rewindLog',
  setComposerTextSource + '\nreturn setComposerText;',
)
const makeSetComposerText = ({ facade, previousDomText = '', t = (key) => `[${key}]` }) => {
  const hintsShown = []
  // 假输入框就是真实 composerText() 读到的那个元素（见上面的假 DOM）。
  composerEl.textContent = previousDomText
  const setComposerText = setComposerTextFactory(
    () => facade,
    real.composerText,
    real.writeComposer,
    (text) => { hintsShown.push(text) },
    t,
    { warn() {}, info() {}, error() {}, debug() {} },
  )
  return { setComposerText, hintsShown }
}

// ── 假会话 / 假 chat ────────────────────────────────────────────────────────
const userNode = (seq, text) => ({
  kind: 'user',
  data: {
    seq,
    time: 1700000000000,
    content: text === null
      ? [{ type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png' } }]
      : [{ type: 'text', text }],
  },
})
const commandNode = (seq, outcome) => ({
  kind: 'command',
  data: { seq, name: 'rewind-plugin', args: ' @10 chat', outcome },
})
function makeChat(nodes) {
  const map = new Map()
  for (const node of nodes) map.set(`${node.kind}:${node.data.seq}`, node)
  const chat = {
    nodes: map,
    order: [...map.keys()],
    getSnapshot() { return chat },
    subscribe() { return () => {} },
    add(node) {
      const key = `${node.kind}:${node.data.seq}`
      if (!map.has(key)) {
        map.set(key, node)
        chat.order.push(key)
      }
    },
  }
  return chat
}
// 真实宿主在执行命令之后才把 command/run + command/done 节点写进会话日志。
// 这里在 command() 返回前把节点塞进 chat，模拟「执行完成」；waitForCommand 的
// watch 会在微任务里再读一次 chat 从而拿到 outcome。
function makeSession({ chat, commandResult, outcome = { kind: 'success', sourceEventSeq: 31 }, onCommand }) {
  return {
    sessionId: 'sess-a',
    command: async (line) => {
      onCommand?.(line)
      if (outcome !== null) chat.add(commandNode(30, outcome))
      return commandResult ?? { ok: true, value: { matched: true } }
    },
    _chat: chat,
  }
}
const watchChat = (_sessionId, cb) => {
  queueMicrotask(cb)
  return () => {}
}
const chatOf = (session) => session._chat
// 真实宿主里 isMainViewSession 接收的是 sessionId（字符串），不是 session 对象。
const isMainViewSession = (sessionId) => sessionId === 'sess-a'

// 超时用例不必真等 20s：临时把 setTimeout 换成「下一轮微任务就触发」。
async function withImmediateTimeout(run) {
  const original = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  globalThis.setTimeout = (cb) => { queueMicrotask(cb); return 0 }
  globalThis.clearTimeout = () => {}
  try {
    return await run()
  } finally {
    globalThis.setTimeout = original
    globalThis.clearTimeout = originalClear
  }
}

async function runRewind({ chat, session, seq = 10, mode = 'chat', setComposerText, restoreImages, isMainView = isMainViewSession }) {
  const calls = { set: [], images: [] }
  const wrapped = (sessionId, text) => {
    calls.set.push({ sessionId, text })
    return setComposerText(sessionId, text)
  }
  const face = session ?? makeSession({ chat })
  await real.runRewindAndFill(
    face,
    seq,
    mode,
    isMainView,
    chatOf,
    watchChat,
    wrapped,
    restoreImages === undefined
      ? undefined
      : async (sessionId, images) => {
        calls.images.push({ sessionId, images })
        await restoreImages(sessionId, images)
      },
  )
  return calls
}

// ── 1) 输入框非空 → 仍然覆盖（本次修复的正面用例）────────────────────────────
console.log('1) 输入框已有内容时，回退必须覆盖它')
{
  const chat = makeChat([userNode(10, '第一条提问')])
  let written = null
  const { setComposerText, hintsShown } = makeSetComposerText({
    facade: { setDraft: (text) => { written = text }, focus() {} },
    previousDomText: '随便写点东西',
  })
  const calls = await runRewind({ chat, setComposerText })
  check(calls.set.length === 1, '写入了一次输入框', String(calls.set.length))
  check(written === '第一条提问', '写入的是被撤回的那句话', String(written))
  check(calls.set[0].sessionId === 'sess-a', '写到回退发生的会话', String(calls.set[0].sessionId))
  check(hintsShown.length === 1 && hintsShown[0] === '[refill.replaced]',
    '原有草稿被替换时给出提示', JSON.stringify(hintsShown))
}

// ── 1b) 没有 facade 时退回 DOM：非空输入框同样必须被覆盖 ─────────────────────
console.log('1b) 宿主 facade 不可用、只有 DOM 输入框时，也必须覆盖已有内容')
{
  const chat = makeChat([userNode(10, '第一条提问')])
  const { setComposerText, hintsShown } = makeSetComposerText({
    facade: undefined,
    previousDomText: '随便写点东西',
  })
  composerEl.textContent = '随便写点东西'
  const applied = setComposerText('sess-a', '第一条提问')
  check(applied === true, 'DOM 路径写入成功', String(applied))
  check(composerEl.textContent === '第一条提问', 'DOM 输入框被覆盖', JSON.stringify(composerEl.textContent))
  check(hintsShown.length === 1, 'DOM 路径也给出替换提示', JSON.stringify(hintsShown))
}

// ── 2) 输入框为空 → 照旧填回（不回归）───────────────────────────────────────
console.log('2) 输入框为空时照旧填回，且不弹替换提示')
{
  const chat = makeChat([userNode(10, '第一条提问')])
  let written = null
  const { setComposerText, hintsShown } = makeSetComposerText({
    facade: { setDraft: (text) => { written = text }, focus() {} },
    previousDomText: '',
  })
  const calls = await runRewind({ chat, setComposerText })
  check(calls.set.length === 1, '写入了一次输入框', String(calls.set.length))
  check(written === '第一条提问', '写入被撤回的那句话', String(written))
  check(hintsShown.length === 0, '没有多余提示', JSON.stringify(hintsShown))
}

// ── 3) 纯空白草稿不算「原有内容」：仍然覆盖，但不打扰 ───────────────────────
console.log('3) 纯空白草稿：仍然覆盖，不弹提示')
{
  const chat = makeChat([userNode(10, '第一条提问')])
  let written = null
  const { setComposerText, hintsShown } = makeSetComposerText({
    facade: { setDraft: (text) => { written = text }, focus() {} },
    previousDomText: '   \n  ',
  })
  await runRewind({ chat, setComposerText })
  check(written === '第一条提问', '覆盖成功', String(written))
  check(hintsShown.length === 0, '纯空白不算「原有内容」', JSON.stringify(hintsShown))
}

// ── 4) 回退没有成功时，绝不写输入框 ─────────────────────────────────────────
console.log('4) 回退没有成功时，绝不写输入框')
{
  // 4a 命令被拒绝
  {
    let written = 0
    const { setComposerText } = makeSetComposerText({ facade: { setDraft: () => { written++ } }, previousDomText: '草稿' })
    const chat = makeChat([userNode(10, '第一条提问')])
    const session = makeSession({ chat, commandResult: { ok: false, error: { code: 'bad' } } })
    const calls = await runRewind({ chat, session, setComposerText })
    check(written === 0, '命令被拒绝时不写', String(written))
    check(calls.set.length === 0, '没有调用写入通道', String(calls.set.length))
  }
  // 4b 命令未被匹配
  {
    let written = 0
    const { setComposerText } = makeSetComposerText({ facade: { setDraft: () => { written++ } }, previousDomText: '草稿' })
    const chat = makeChat([userNode(10, '第一条提问')])
    const session = makeSession({ chat, commandResult: { ok: true, value: { matched: false } } })
    const calls = await runRewind({ chat, session, setComposerText })
    check(written === 0, '命令未匹配时不写', String(written))
    check(calls.set.length === 0, '没有调用写入通道', String(calls.set.length))
  }
  // 4c 命令抛异常
  {
    let written = 0
    const { setComposerText } = makeSetComposerText({ facade: { setDraft: () => { written++ } }, previousDomText: '草稿' })
    const chat = makeChat([userNode(10, '第一条提问')])
    const session = {
      sessionId: 'sess-a',
      command: async () => { throw new Error('rpc down') },
      _chat: chat,
    }
    const calls = await runRewind({ chat, session, setComposerText })
    check(written === 0, '命令抛异常时不写', String(written))
    check(calls.set.length === 0, '没有调用写入通道', String(calls.set.length))
  }
  // 4d outcome 是 failed（宿主写入失败，命令节点存在但不是 success）
  {
    let written = 0
    const { setComposerText } = makeSetComposerText({ facade: { setDraft: () => { written++ } }, previousDomText: '草稿' })
    const chat = makeChat([userNode(10, '第一条提问')])
    const session = makeSession({ chat, outcome: { kind: 'failed', sourceEventSeq: 31, text: 'boom' } })
    const calls = await withImmediateTimeout(() => runRewind({ chat, session, setComposerText }))
    check(written === 0, 'outcome=failed 时不写', String(written))
    check(calls.set.length === 0, '没有调用写入通道', String(calls.set.length))
  }
  // 4e 超时：命令节点始终不出现
  {
    let written = 0
    const { setComposerText } = makeSetComposerText({ facade: { setDraft: () => { written++ } }, previousDomText: '草稿' })
    const chat = makeChat([userNode(10, '第一条提问')])
    const session = makeSession({ chat, outcome: null })
    const calls = await withImmediateTimeout(() => runRewind({ chat, session, setComposerText }))
    check(written === 0, '超时不写', String(written))
    check(calls.set.length === 0, '没有调用写入通道', String(calls.set.length))
  }
}

// ── 5) 非主视图会话 → 不写输入框 ────────────────────────────────────────────
console.log('5) 非主视图会话不回填（多窗口下不能填错会话）')
{
  const chat = makeChat([userNode(10, '第一条提问')])
  let written = 0
  const { setComposerText } = makeSetComposerText({ facade: { setDraft: () => { written++ } }, previousDomText: '' })
  const calls = await runRewind({ chat, setComposerText, isMainView: () => false })
  check(written === 0, '非主视图不写', String(written))
  check(calls.set.length === 0, '没有调用写入通道', String(calls.set.length))
}

// ── 6) 纯图片消息：恢复图片，但不写空文字 ──────────────────────────────────
console.log('6) 目标消息只有图片：恢复图片，不写文字')
{
  const chat = makeChat([userNode(10, null)])
  let written = 0
  const restored = []
  const { setComposerText } = makeSetComposerText({ facade: { setDraft: () => { written++ } }, previousDomText: '草稿' })
  const calls = await runRewind({
    chat,
    setComposerText,
    restoreImages: async (sessionId, images) => { restored.push({ sessionId, images }) },
  })
  check(written === 0, '没有文字可填时不写', String(written))
  check(restored.length === 1 && restored[0].images.length === 1, '图片恢复被调用一次', String(restored.length))
  check(calls.images.length === 1, 'restoreImages 经 runRewindAndFill 调用', String(calls.images.length))
}
// ── 7) 写入通道不可用 → 明确返回 false，不抛 ────────────────────────────────
console.log('7) 写入通道不可用时返回 false（调用方据此告警），且不抛异常')
{
  composerPresent = false
  const { setComposerText } = makeSetComposerText({ facade: undefined, previousDomText: '草稿' })
  let applied
  try {
    applied = setComposerText('sess-a', 'x')
  } catch (error) {
    check(false, '写入通道不可用时不得抛异常', error?.message)
  }
  check(applied === false, '没有输入框时返回 false', String(applied))
  composerPresent = true
}

// ── 8) 目标文字为纯空白时按原样写入（不吞掉用户原话）────────────────────────
console.log('8) 目标文字是纯空白时按原样写入')
{
  const chat = makeChat([userNode(10, '   ')])
  let written = null
  const { setComposerText } = makeSetComposerText({ facade: { setDraft: (text) => { written = text } }, previousDomText: '' })
  await runRewind({ chat, setComposerText })
  check(written === '   ', '原样写入纯空白文字', JSON.stringify(written))
}

console.log('')
if (fail === 0) {
  console.log(`全部通过（${pass} 项）`)
  process.exit(0)
}
console.log(`失败 ${fail} 项 / 共 ${pass + fail} 项`)
process.exit(1)
