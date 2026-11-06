#!/usr/bin/env node
// 回归：回退失败提示必须是本地化、可操作的文案。
//
// 事故（用户截图）：点 ↶ 回退到一条已被撤下的消息，界面显示
//   无法获取影响清单：user message at seq 127 is no longer in the model
//   context (shadowed by compaction)
// 三个问题：
//   1) 内层是宿主英文原文，没本地化；
//   2) "shadowed by compaction" 说法错误 —— 实际是被后续的回退/重生成撤下；
//   3) 没告诉用户下一步该做什么。
//
// 修复：宿主侧文案改成准确描述；客户端按错误码映射成本地化文案，
// 英文原文只进日志。
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const clientSrc = await readFile(join(root, 'lib', 'client.js'), 'utf8')
const hostSrc = await readFile(join(root, 'lib', 'index.js'), 'utf8')

let pass = 0, fail = 0
const check = (ok, label, detail = '') => {
  if (ok) { pass++; console.log('  ok   ' + label) }
  else { fail++; console.log('  FAIL ' + label + (detail ? ` — ${detail}` : '')) }
}

function grab(src, name) {
  const i = src.indexOf('function ' + name)
  if (i < 0) throw new Error(name + ' not found')
  let d = 0, j = src.indexOf('{', i)
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) break } }
  return src.slice(i, j + 1)
}

console.log('1) 宿主侧：not-on-surface 文案不再写 shadowed by compaction')
{
  check(!hostSrc.includes('(shadowed by compaction)'), '旧的误导性文案已移除')
  check(/withdrawn by a later rewind\/regenerate/.test(hostSrc), '新文案说明「被后续回退/重生成撤下」')
  check(/Pick a message that is still shown as active/.test(hostSrc), '新文案告诉用户该怎么做')
}

console.log('2) 客户端：按错误码映射成本地化文案')
{
  const fn = grab(clientSrc, 'knownPreviewErrorText')
  const t = (k, p) => `[${k}${p && p.seq !== undefined ? ' seq=' + p.seq : ''}]`
  // t 现在是显式第 3 个参数：该函数在模块顶层，而 t 是 apply() 里的局部变量，
  // 早先裸调 t() 会抛 ReferenceError（界面显示「无法获取影响清单：t is not defined」）。
  const known = new Function(fn + '\nreturn knownPreviewErrorText')()
  const call = (error, seq) => known(error, seq, t)

  check(call({ code: 'rewind/not-on-surface', message: 'x' }, 127) === '[previewError.notOnSurface seq=127]',
    '错误码命中 notOnSurface')
  check(call({ message: 'user message at seq 127 is no longer in the model context (shadowed by compaction)' }, 127) === '[previewError.notOnSurface seq=127]',
    '旧宿主英文文案也能兜底映射')
  check(call({ code: 'rewind/not-a-user-message', message: 'x' }, 5) === '[previewError.notUserMessage]',
    '非用户消息 → notUserMessage')
  check(call({ code: 'rewind/invalid-index', message: 'x' }, 9) === '[previewError.invalidTarget]',
    '非法目标 → invalidTarget')
  check(call({ code: 'rewind/failed', message: 'boom' }, 3) === undefined,
    '未知错误不臆测，交回调用方用宿主原文')
}

console.log('3) 客户端：previewOverRpc 不再把宿主英文原文当界面文案')
{
  check(!/return \{ kind: "error", text: result\.error\.message \}/.test(clientSrc),
    '已改为先查本地化映射')
  check(/knownPreviewErrorText\(result\.error, seq, translate\)/.test(clientSrc), '调用本地化映射（显式传 translate）')
  check(/previewError\.invalidResponse/.test(clientSrc), '非法响应用本地文案')
  check(/previewError\.unavailable/.test(clientSrc), 'RPC 不可用用本地文案')
  check(/previewOverRpc\(sessionId, seq, t\)/.test(clientSrc), 'apply 里把 t 传进 previewOverRpc')
  // 回归：preview 走 /api 下的 exact Fetch 路由，不再走 connection.rpc.call。
  // 后者在真实宿主里注册不上（owner 读 webServer 抛 inject 错误）→ HTTP 405。
  check(!/connection\.rpc\.call\(/.test(clientSrc), '不再走 connection.rpc.call（宿主注册不上，会 405）')
  check(/var RPC_PATH = "api\/dsh-rewind\/rpc"/.test(clientSrc), 'preview 走 /api 下的 exact Fetch 路由')
}

console.log('4) 三语齐全（每个键都必须有 en/zh/ja 三条）')
{
  const keys = ['notOnSurface', 'notUserMessage', 'invalidTarget', 'invalidResponse', 'unavailable']
  for (const k of keys) {
    // 只数「定义」的行（"key": "..."），代码里的 t("key", ...) 调用不算
    const n = (clientSrc.match(new RegExp('"previewError\\.' + k + '": ', 'g')) ?? []).length
    check(n === 3, `previewError.${k} 有 en/zh/ja 三条定义`, String(n))
  }
  // 中文文案必须是转义形式（与文件其它条目一致）且能解码出中文
  const m = clientSrc.match(/"previewError\.notOnSurface": "((?:[^"\\]|\\.)*)",/)
  check(m !== null, '找到 notOnSurface 的首条（en）')
  const zhLine = clientSrc.match(/"previewError\.notOnSurface": "((?:\\u[0-9A-F]{4}[^"\\]*)+)"/)
  check(zhLine !== null, '存在 \\u 转义的中文/日文条目')
  if (zhLine !== null) {
    const decoded = JSON.parse('"' + zhLine[1] + '"')
    check(/[\u4e00-\u9fff]/.test(decoded) || /[\u3040-\u30ff]/.test(decoded), '转义条目能解码出中日文', decoded.slice(0, 30))
  }
}

console.log('')
console.log(fail === 0 ? `全部通过（${pass} 项）` : `失败 ${fail} 项 / 共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)
