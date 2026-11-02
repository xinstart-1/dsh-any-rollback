#!/usr/bin/env node
// 回归测试：/regen 命令面（宿主侧缺陷 1-5 的行为护栏）。
//
// 目标：把「点了 ↻ 就拿到 `regen · fs is not defined`」这一类**顶层 ReferenceError**
// 变成可复现的红灯。做法是真正调用 lib/index.js 导出的 apply()，用伪造的 cordis
// 上下文把五个命令注册出来，然后直接拿 /regen 的 handler 跑六种输入。
//
// 本仓库没有 node_modules（宿主包由 DSH 运行时提供），所以先用 node:module 的
// registerHooks 把三个裸包名换成最小桩件，再动态 import lib/index.js。
// 桩件只补 apply()/Config 构造期用到的那几个符号，见各桩件注释。
//
// 本文件只读 lib/，不修改任何源码；断言只依赖「行为」，不依赖本地化文案
// （唯一例外：/regen v9 的越界文案里带 want/total 两个数字，已在该节注明）。
//
// 覆盖不到的一项：缺陷 3（`isJournalPathSafe` 用了未导入的 node:path `resolve`）
// 不在任何命令 handler 的可达路径上 —— 只有从磁盘读回 restore journal
// （journalFromJson → reconcileRestores / continueRestore）才会碰到，属于
// 宿主重启后的恢复路径。本测试不做静态检查，因此对该缺陷是盲的；
// 需要另外的 journal 恢复用例才能覆盖。

import { registerHooks } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── 宿主包桩件 ────────────────────────────────────────────────────────────────
// 1) @deepseek-ai/dsh-llm —— 只有 buildMarker() 用到 createUserMessage()
const LLM_STUB = `
let counter = 0
export function createUserMessage(init) {
  counter += 1
  return { id: 'stub-msg-' + counter, role: 'user', createdAt: 1700000000000, ...init }
}
`
// 2) @deepseek-ai/schemastery —— 只用于构造 Config 常量；链式调用一律返回自身
const SCHEMA_STUB = `
const target = function SchemasteryStub() {}
const chain = new Proxy(target, {
  get(_target, key) {
    if (typeof key === 'symbol' || key === 'then' || key === 'constructor' || key === 'prototype') return undefined
    return () => chain
  },
  apply() { return chain },
})
export default chain
`
// 3) @deepseek-ai/dsh-home-paths —— 只在没给 snapshotDir/dshHome 时才被用到
const HOME_STUB = `
export function resolveDshHome(explicit) {
  return explicit ?? process.env.DSH_HOME ?? 'C:/dsh-home-stub'
}
`
const STUBS = new Map([
  ['@deepseek-ai/dsh-llm', LLM_STUB],
  ['@deepseek-ai/schemastery', SCHEMA_STUB],
  ['@deepseek-ai/dsh-home-paths', HOME_STUB],
])

const stubUrls = new Map(
  [...STUBS].map(([specifier, source]) => [specifier, 'data:text/javascript,' + encodeURIComponent(source)]),
)
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = stubUrls.get(specifier)
    return url === undefined ? nextResolve(specifier, context) : { url, shortCircuit: true }
  },
})

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

// 所有 handler 调用里冒出来的 ReferenceError 汇总在这里，末尾统一断言为 0。
// 这正是线上那条 `regen · fs is not defined` 的形态。
const referenceErrors = []
const isReferenceError = (error) =>
  error instanceof ReferenceError || /\bis not defined\b/.test(String(error?.message ?? ''))
const describeError = (error) =>
  error === undefined ? '(no error)' : `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
// 详情渲染：任何值都必须能安全地塞进一行日志（undefined / 函数 / 循环引用都不能抛）
const show = (value) => {
  let text
  if (typeof value === 'string') text = value
  else if (typeof value === 'function') text = 'function ' + (value.name || '(anonymous)')
  else {
    try { text = JSON.stringify(value) ?? String(value) } catch { text = String(value) }
  }
  text = String(text).replaceAll('\r', ' ').replaceAll('\n', '\\n')
  return text.length > 160 ? text.slice(0, 157) + '...' : text
}

// ── 伪造 cordis 上下文 ────────────────────────────────────────────────────────
// apply() 在装配期实际用到的东西（见 lib/index.js 的 apply()）：
//   ctx.settings.describe/update/mutate/configure、ctx.logger.warn、
//   ctx.effect(工厂形式 + 生成器形式)、ctx.inject(names, cb)、ctx.on(event, handler, opts)、
//   ctx.commands.register(spec)、ctx.fiber.entry.id、ctx.emit(fs/observed)。
// 与真实 cordis 的差异见文件末尾 REPORT 注释。
function createFakeCtx({ services = {}, fiberId = 'tests/regen-command' } = {}) {
  const disposers = []
  const handlers = new Map()
  const commands = new Map()
  const logs = []
  const emitted = []
  const settingsCalls = { describe: 0, update: [], mutate: [], configure: [] }
  const injections = []
  const strayYields = []

  const fmt = (value) => (value instanceof Error ? value.message : String(value))
  const logger = {
    warn: (...args) => logs.push({ level: 'warn', message: args.map(fmt).join(' ') }),
    error: (...args) => logs.push({ level: 'error', message: args.map(fmt).join(' ') }),
    info: (...args) => logs.push({ level: 'info', message: args.map(fmt).join(' ') }),
    debug: (...args) => logs.push({ level: 'debug', message: args.map(fmt).join(' ') }),
  }

  const ctx = {
    logger,
    // 真实 cordis 的 fiber 指向插件条目；apply() 只用 fiber.entry.id
    fiber: { entry: { id: fiberId } },
    settings: {
      // 故意不返回 locale 行 → readHostLocale() 退回 DEFAULT_HOST_LOCALE('en')
      describe: () => { settingsCalls.describe++; return [] },
      update: (id, patch) => { settingsCalls.update.push({ id, patch }); return Promise.resolve() },
      mutate: (id, fields) => { settingsCalls.mutate.push({ id, fields }); return Promise.resolve() },
      configure: (patch, fiber) => { settingsCalls.configure.push({ patch, fiber }); return () => {} },
    },
    commands: {
      register(spec) {
        if (spec === null || typeof spec !== 'object') throw new TypeError('command spec must be an object')
        if (typeof spec.name !== 'string' || spec.name === '') throw new TypeError('command name must be a string')
        if (typeof spec.handler !== 'function') throw new TypeError(`command "${spec.name}" has no handler`)
        if (commands.has(spec.name)) throw new Error(`command "${spec.name}" is already registered`)
        commands.set(spec.name, spec)
        // 真实服务返回反注册函数；这里给 no-op，避免误触发把命令表清掉
        return () => {}
      },
    },
    // cordis 的 effect 有两种形态，apply() 两种都用：
    //   a) 工厂：ctx.effect(() => dispose, label) —— 立刻调用工厂，只保留返回的 disposer
    //   b) 生成器：ctx.effect(function* () { ... yield register(...) ... }, label)
    // 生成器必须真的推进到结束，否则五个命令一个都注册不上。
    effect(fn, label = '') {
      if (typeof fn !== 'function') throw new TypeError('ctx.effect expects a function')
      if (fn.constructor?.name === 'GeneratorFunction') {
        const gen = fn()
        const yielded = []
        let step = gen.next()
        while (!step.done) {
          const value = step.value
          if (typeof value === 'function') yielded.push(value)
          // 生成器里 yield promise 需要 await；这里的注册逻辑全是同步的，
          // 出现 thenable 说明装配语义变了，记下来而不是静默死循环。
          else if (value !== null && typeof value?.then === 'function') strayYields.push(label)
          step = gen.next(value)
        }
        const dispose = () => { for (const item of yielded) { try { item() } catch {} } }
        disposers.push({ label, dispose })
        return dispose
      }
      const produced = fn()
      const dispose = typeof produced === 'function'
        ? produced
        : typeof produced?.dispose === 'function' ? () => produced.dispose() : () => {}
      disposers.push({ label, dispose })
      return dispose
    },
    // cordis 的 inject 在服务就绪后回调子作用域；这里同步回调，把选中的服务挂上去
    inject(names, cb) {
      if (!Array.isArray(names) || typeof cb !== 'function') throw new TypeError('ctx.inject expects (names, cb)')
      const child = Object.create(ctx)
      for (const name of names) {
        if (services[name] !== undefined) child[name] = services[name]
      }
      injections.push({ names: [...names] })
      cb(child)
      return () => {}
    },
    on(event, handler, options) {
      if (typeof handler !== 'function') throw new TypeError('ctx.on expects a handler function')
      const list = handlers.get(event) ?? []
      list.push({ handler, options })
      handlers.set(event, list)
      return () => {}
    },
    emit(event, ...args) { emitted.push({ event, args }) },
    get(name) { return services[name] },
  }
  ctx.root = ctx

  return {
    ctx,
    services,
    commandSpecs: commands,
    eventHandlers: handlers,
    logs,
    emitted,
    settingsCalls,
    injections,
    strayYields,
  }
}

// ── 伪造会话/agent ────────────────────────────────────────────────────────────
// 事件形状按 lib/index.js 的读法构造：
//   isHumanUserMessageEvent → event.data.source.kind === 'user'
//   extractUserText         → event.data.message.content[].text
//   版本页 / list           → event.data.op === 'regenerate'、event.data.sourceEventSeqs
function createSession({ id, events }) {
  const list = events.map((event) => ({ time: 1_700_000_000_000, ...event }))
  const nodes = list
    .filter((event) => event.type === 'user/message' || event.type === 'assistant/message')
    .map((event) => event.seq)
  let seqCursor = list.reduce((max, event) => Math.max(max, event.seq), 0)

  return {
    id,
    // isSubagentSession() 只看 header；regen 路径不触发，但保持形状可用
    header: { version: 2, origin: 'user', cwd: process.cwd() },
    surface: { nodes },
    snapshotEvents: () => list.slice(),
    // 让遮蔽标记真的落进日志并改写 surface：这样「切版本」的副作用可断言
    append(type, message, options = {}) {
      seqCursor += 1
      const seq = seqCursor
      const replace = options.surfaceOp
      if (replace?.op === 'replace') {
        const kept = nodes.filter((nodeSeq) => nodeSeq < replace.startSeq || nodeSeq > replace.endSeq)
        nodes.length = 0
        nodes.push(...kept)
      }
      nodes.push(seq)
      const data = {
        ...(message?.data ?? {}),
        message: { role: message?.role ?? 'user', content: message?.content ?? [] },
        source: message?.source ?? { kind: 'user' },
        ...(options.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: [...options.sourceEventSeqs] }),
      }
      const event = { seq, type, time: 1_700_000_000_000 + seq, data }
      list.push(event)
      return event
    },
  }
}

function createAgent(session, { status = 'idle' } = {}) {
  const followups = []
  const cancels = []
  return {
    id: 'agent-' + session.id,
    session,
    status,
    followups,
    cancels,
    followup(message) { followups.push(message); return Promise.resolve() },
    cancel(...args) { cancels.push(args) },
    whenIdle() { return Promise.resolve() },
    inbox: { nextStep: [], remove() {} },
  }
}

// 统一调用口：任何 throw 都变成 { ok:false }，ReferenceError 另外记账
// 这里刻意只喂宿主真正提供的字段（CommandInvocation = {commandId, agent, rawInput, attachments, signal}）：
// 宿主没有 input，若 handler 去读 invocation.input，raw 恒为空、list/help/v<N> 全部退化——
// 那种情况下下面的断言会失败，从而把字段名写错这种缺陷挡在本地。
async function invokeRegen(handler, agent, input) {
  const controller = new AbortController()
  const invocation = { commandId: 'cmd-1', agent, rawInput: input, attachments: [], signal: controller.signal }
  try {
    return { ok: true, result: await handler(invocation) }
  } catch (error) {
    if (isReferenceError(error)) referenceErrors.push({ input, error })
    return { ok: false, error }
  }
}

const humanUserEvent = (seq, text) => ({
  type: 'user/message',
  seq,
  data: { message: { role: 'user', content: [{ type: 'text', text }] }, source: { kind: 'user', rpcId: 'r1' } },
})
const assistantEvent = (seq) => ({
  type: 'assistant/message',
  seq,
  data: { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, source: { kind: 'model' } },
})
// 插件自己追加的遮蔽标记（真实形状：source.kind 为 'dsh-rewind'，非人类消息）
const regenMarkerEvent = (seq, cited) => ({
  type: 'user/message',
  seq,
  data: {
    op: 'regenerate',
    sourceEventSeqs: [...cited],
    message: { role: 'user', content: [{ type: 'text', text: '(empty message)' }] },
    source: { kind: 'dsh-rewind' },
  },
})
// 真实宿主落盘形态（取自会话日志实测）：sourceEventSeqs 是**事件顶层字段**（append 的第三个
// 参数原样落盘，不在 data 里），且连续区间被压成嵌套数组。读 event.data.sourceEventSeqs 会
// 恒为 undefined → 列表条目丢掉回退点、/regen v<N> 报「没有重新生成记录」。
const hostShapedMarkerEvent = (seq, nestedCited) => ({
  type: 'user/message',
  seq,
  data: {
    op: 'regenerate',
    message: { role: 'user', content: [{ type: 'text', text: '(empty message)' }] },
    source: { kind: 'dsh-rewind' },
  },
  sourceEventSeqs: nestedCited,
  surfaceOp: { op: 'replace', startSeq: 10, endSeq: 14 },
})

// ── 装配 ──────────────────────────────────────────────────────────────────────
let harness
try {
  const mod = await import('../lib/index.js')
  const { apply, Config, ENGINE_COMMAND } = mod
  check(typeof apply === 'function', 'lib/index.js 导出 apply()', typeof apply)
  check(typeof ENGINE_COMMAND === 'string' && ENGINE_COMMAND !== '', 'lib/index.js 导出 ENGINE_COMMAND', show(ENGINE_COMMAND))
  check(Config !== undefined, 'lib/index.js 导出 Config（schema 由桩件提供）', typeof Config)

  const base = await mkdtemp(join(tmpdir(), 'regen-command-'))
  const config = {
    snapshotDir: join(base, 'snap'),
    dshHome: join(base, 'dsh-home'),
    artifactTrackingEnabled: true,
  }

  // fs / workingDirectory 服务：执行路径只用到 fs.resolve / fs.stat，
  // 且 syncRestoreObservations 先看 fs 是否为 undefined —— 提供桩件是为了
  // 让 fsService 真的被捕获，从而走到「有 fs」的那条分支。
  const fsService = {
    async resolve(path) { return { displayPath: path } },
    async stat() { return { type: 'file', size: 0, version: 'v0' } },
  }
  const workingDirectory = { async ensure() { return process.cwd() } }

  harness = createFakeCtx({ services: { fs: fsService, workingDirectory } })
  apply(harness.ctx, config)
  harness.base = base

  console.log('1) 命令面：apply() 必须把五个命令全部注册出来')
  const required = ['rewind', 'undo', 'regen', ENGINE_COMMAND, 'snapshot-auto-cleanup']
  for (const name of required) {
    check(harness.commandSpecs.has(name), `命令已注册：${name}`, [...harness.commandSpecs.keys()].join(','))
  }
  check(harness.eventHandlers.has('agent/created'), '订阅 agent/created')
  check(harness.eventHandlers.has('session/event'), '订阅 session/event')
  check(harness.injections.some((item) => item.names.includes('fs')), 'inject([fs, workingDirectory]) 已回调')
  check(harness.strayYields.length === 0, '生成器 effect 没有 yield promise（装配应全程同步）', harness.strayYields.join(','))

  const regenSpec = harness.commandSpecs.get('regen')
  check(typeof regenSpec?.handler === 'function', '/regen 有 handler')
  if (typeof regenSpec?.handler !== 'function') {
    throw new Error('/regen 未注册，后续用例无法执行')
  }
  const regenHandler = regenSpec.handler

  // ── 2) help：用法文本必须是真换行 ──
  console.log('2) /regen help：用法文本里的换行必须是真的 \\n（缺陷 5）')
  {
    const session = createSession({ id: 'sess-help', events: [humanUserEvent(10, 'render it'), assistantEvent(14)] })
    const call = await invokeRegen(regenHandler, createAgent(session), 'help')
    check(call.ok, '/regen help 不抛异常', describeError(call.error))
    check(call.ok && call.result?.kind === 'success', '/regen help 返回 success', show(call.result))
    const text = call.ok ? String(call.result?.text ?? '') : ''
    check(text.includes('\n'), '用法文本含真换行字符', show(text))
    check(!text.includes('\\n'), '用法文本不含字面反斜杠 + n', show(text))
    // 同源缺陷：命令面板的输入提示复用了同一串文案
    const hint = String(regenSpec.input?.hint ?? '')
    check(!hint.includes('\\n'), '命令 input.hint 不含字面反斜杠 + n', show(hint))
  }

  // ── 3) list：空历史 / 一条历史 ──
  console.log('3) /regen list：空历史与带一条重新生成记录的会话')
  {
    const empty = createSession({ id: 'sess-list-empty', events: [humanUserEvent(10, 'render it'), assistantEvent(14)] })
    const call = await invokeRegen(regenHandler, createAgent(empty), 'list')
    check(call.ok, '/regen list（空）不抛异常', describeError(call.error))
    check(call.ok && call.result?.kind === 'success', '/regen list（空）返回 success', show(call.result))
    const text = call.ok ? String(call.result?.text ?? '') : ''
    check(!text.includes('#'), '空历史文案里没有条目行（不含 #）', show(text))

    const oneMarker = createSession({
      id: 'sess-list-one',
      events: [humanUserEvent(10, 'render it'), assistantEvent(14), regenMarkerEvent(20, [10, 14])],
    })
    const call2 = await invokeRegen(regenHandler, createAgent(oneMarker), 'list')
    check(call2.ok, '/regen list（一条）不抛异常', describeError(call2.error))
    check(call2.ok && call2.result?.kind === 'success', '/regen list（一条）返回 success', show(call2.result))
    const text2 = call2.ok ? String(call2.result?.text ?? '') : ''
    check(text2.includes('20'), '列表里出现标记 seq 20', show(text2))

    // 宿主真实形态：sourceEventSeqs 在顶层且是嵌套区间 [[10,12],14]
    const hosted = createSession({
      id: 'sess-list-host',
      events: [humanUserEvent(10, 'render it'), assistantEvent(14), hostShapedMarkerEvent(20, [[10, 12], 14])],
    })
    const call3 = await invokeRegen(regenHandler, createAgent(hosted), 'list')
    check(call3.ok && call3.result?.kind === 'success', '/regen list（宿主形态）返回 success', show(call3.result))
    const text3 = call3.ok ? String(call3.result?.text ?? '') : ''
    check(text3.includes('20'), '宿主形态：列表里出现标记 seq 20', show(text3))
    check(text3.includes('10'), '宿主形态：回退点解析为 10（顶层 + 嵌套区间展平）', show(text3))
  }

  // ── 4) v1：版本页切换（/^v(d+)$/ 正则转义缺陷的护栏）──
  console.log('4) /regen v1：必须命中版本页分支（缺陷 4：/^v(d+)$/ 丢了反斜杠）')
  {
    const session = createSession({
      id: 'sess-v1',
      events: [humanUserEvent(10, 'render it'), assistantEvent(14), regenMarkerEvent(20, [10, 14])],
    })
    const agent = createAgent(session)
    const call = await invokeRegen(regenHandler, agent, 'v1')
    check(call.ok, '/regen v1 不抛异常', describeError(call.error))
    check(!isReferenceError(call.error), '/regen v1 没有 ReferenceError', describeError(call.error))
    check(call.ok && call.result?.kind === 'success', '/regen v1 返回 success（kind=error 说明落进了提示词分支）', show(call.result))
    const text = call.ok ? String(call.result?.text ?? '') : ''
    check(text.includes('10'), '切换文案引用了回退点 #10', show(text))
    // 行为断言（与文案无关）：切版本会再追加一条遮蔽标记
    const markers = session.snapshotEvents().filter((event) => event.type === 'user/message' && event.data?.op === 'regenerate')
    check(markers.length === 2, '切版本后日志里多了一条 regenerate 标记', String(markers.length))
    check(markers.at(-1)?.data?.regenSwitchTo === 1, '新标记记录了 regenSwitchTo=1', show(markers.at(-1)?.data))
  }

  // ── 5) v9：越界 ──
  console.log('5) /regen v9：只有 1 个版本时必须报越界错误')
  {
    const session = createSession({
      id: 'sess-v9',
      events: [humanUserEvent(10, 'render it'), assistantEvent(14), regenMarkerEvent(20, [10, 14])],
    })
    const call = await invokeRegen(regenHandler, createAgent(session), 'v9')
    check(call.ok, '/regen v9 不抛异常', describeError(call.error))
    check(!isReferenceError(call.error), '/regen v9 没有 ReferenceError', describeError(call.error))
    check(call.ok && call.result?.kind === 'error', '/regen v9 返回 error', show(call.result))
    const text = call.ok ? String(call.result?.text ?? '') : ''
    // 越界文案（en：'No version {want}; this prompt has {total} version(s).'）里
    // 同时出现 want=9 和 total=2；落进提示词分支的 invalid-target 文案只有 9。
    // 这里锁定 en 文案：readHostLocale() 在 settings.describe 没有 locale 行时
    // 退回 DEFAULT_HOST_LOCALE='en'，所以是确定的。
    check(text.includes('9') && text.includes('2'), '越界文案同时带 want=9 与 total=2', show(text))
    // 与文案无关的判据：落进提示词分支时抛的是 invalid-target（文案里带原始
    // token "v9"），越界文案里只有数字。这条在中文/日文词典下同样成立。
    check(!text.includes('v9'), '越界文案不是 invalid-target 分支（不含原始 token）', show(text))
  }

  // ── 6) 空输入：深度路径（回退 + 重发提示词）──
  console.log('6) /regen（空输入）：回退最新人类消息并重发其提示词')
  {
    const session = createSession({ id: 'sess-deep', events: [humanUserEvent(10, 'render it'), assistantEvent(14)] })
    const agent = createAgent(session)
    const call = await invokeRegen(regenHandler, agent, '')
    check(call.ok, '/regen（空）不抛异常', describeError(call.error))
    check(!isReferenceError(call.error), '/regen（空）没有 ReferenceError', describeError(call.error))
    // 软断言说明：这一节一部分行为依赖真实宿主（SnapshotStore 里没有该会话的
    // 记录时 restoreAfter 只是空转），所以「恢复了几份文件」这类断言不做；
    // 这里只断言与文案/宿主无关的三件事：kind、followup 内容、遮蔽标记。
    check(call.ok && call.result?.kind === 'success', '/regen（空）返回 success', show(call.result))
    const text = call.ok ? String(call.result?.text ?? '') : ''
    check(text.includes('10'), '返回文案提到目标 seq 10', show(text))
    check(agent.followups.length === 1, 'agent.followup 被调用一次', String(agent.followups.length))
    const resent = agent.followups[0]
    const resentText = resent?.content?.map((block) => block?.text ?? '').join('') ?? ''
    check(resentText === 'render it', 'followup 携带原始提示词原文', show(resentText))
    const appended = session.snapshotEvents().filter((event) => event.type === 'user/message' && Array.isArray(event.data?.sourceEventSeqs))
    check(appended.length === 1, '空输入路径追加了一条遮蔽标记', String(appended.length))
    check(appended[0] !== undefined && appended[0].data.sourceEventSeqs.includes(10), '遮蔽标记引用了目标 seq 10', show(appended[0]?.data?.sourceEventSeqs))
    // 观察项，不作断言：executeRegenerate() 追加的标记只有 surfaceOp/sourceEventSeqs，
    // 没有 data.op='regenerate'（只有 executeRegenSwitch() 显式补了 op）。若宿主
    // session.append 不会从 surfaceOp 推出 op，则「重新生成出来的标记」在
    // /regen list 与版本页推导里都不可见。上面的断言因此挂在 sourceEventSeqs 上，
    // 不依赖这个尚未定论的行为。
  }

  // ── 7) 空输入 + 没有人类消息 ──
  console.log('7) /regen（空输入）且会话里没有人类消息 → error')
  {
    const session = createSession({ id: 'sess-nouser', events: [assistantEvent(14)] })
    const call = await invokeRegen(regenHandler, createAgent(session), '')
    check(call.ok, '/regen（无人消息）不抛异常', describeError(call.error))
    check(!isReferenceError(call.error), '/regen（无人消息）没有 ReferenceError', describeError(call.error))
    check(call.ok && call.result?.kind === 'error', '/regen（无人消息）返回 error', show(call.result))
  }

  // ── 8) 全局：任何一次调用都不许抛 ReferenceError ──
  console.log('8) 全局不变量：六种输入都不允许抛 ReferenceError')
  check(
    referenceErrors.length === 0,
    '没有 ReferenceError（线上 `regen · fs is not defined` 的形态）',
    referenceErrors.map((item) => `input=${JSON.stringify(item.input)} → ${describeError(item.error)}`).join(' | '),
  )
} catch (error) {
  fail++
  console.log(`  FAIL 装配阶段异常 — ${describeError(error)}`)
  if (error?.stack) console.log(String(error.stack).split('\n').slice(0, 6).join('\n'))
}

if (harness?.base !== undefined) {
  await rm(harness.base, { recursive: true, force: true }).catch(() => {})
}

console.log('')
console.log(fail === 0 ? `全部通过（${pass} 项）` : `失败 ${fail} 项 / 共 ${pass + fail} 项`)
if (harness !== undefined && harness.logs.length > 0) {
  // 宿主日志不参与断言，但排查时有用（例如 warnCommandUnavailable 的注册失败原因）
  console.log(`（宿主日志 ${harness.logs.length} 条，例如：${show(harness.logs[0].message)}）`)
}
process.exit(fail === 0 ? 0 : 1)