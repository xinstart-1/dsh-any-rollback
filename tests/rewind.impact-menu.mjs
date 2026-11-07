#!/usr/bin/env node
// 回归：回退模式菜单必须能看见「会回退哪些文件」（截图 image-28）
//
// 现状（any.30）：点 ↶ 后菜单只有两句说明 ——
//   「仅回退对话」/「回退对话和文件」——
//   「回退对话和文件」的副标题永远是「回退上下文并还原工作区文件」。
// 于是用户要判断这次回退会动哪些文件，必须再点一次进确认页；而那一页只在
// 用户已经做出选择之后才出现。文件范围本该是**选择模式时**的依据。
//
// 修复：预览结果一回来，
//   1) 「回退对话和文件」的副标题换成数量（1 个 / {count} 个）；
//   2) 选项下方直接列出受影响路径（还原/删除各按本地化文案）；
//   3) 超过 INLINE_FILE_LIMIT 条时折叠成「…另有 {count} 个」，确认页仍全列；
//   4) 快照关闭时同样提示「还原可能不充分」。
//
// 本测试：从产物里取出三个纯函数求值，逐条钉住行为；并核对三语文案齐全。
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const clientSrc = await readFile(join(root, 'lib', 'client.js'), 'utf8')

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) { pass++; console.log('  ok   ' + label) }
  else { fail++; console.log('  FAIL ' + label + (detail ? ` — ${detail}` : '')) }
}

function grab(src, name) {
  const i = src.indexOf('function ' + name)
  if (i < 0) throw new Error(name + ' not found')
  let d = 0
  let j = src.indexOf('{', i)
  for (; j < src.length; j++) {
    if (src[j] === '{') d++
    else if (src[j] === '}') { d--; if (!d) break }
  }
  return src.slice(i, j + 1)
}

// 弹窗 DOM 的最小替身：el() 造一个可读的节点，CLASS 用产物里的真实类名。
const realClass = (() => {
  const i = clientSrc.indexOf('var CLASS = {')
  let d = 0
  let j = clientSrc.indexOf('{', i)
  for (; j < clientSrc.length; j++) {
    if (clientSrc[j] === '{') d++
    else if (clientSrc[j] === '}') { d--; if (!d) break }
  }
  return new Function(`return (${clientSrc.slice(i, j + 1).replace(/^var CLASS = /, '')})`)()
})()

const el = (tag, className, text) => {
  const node = { tag, className, text, children: [], append(child) { this.children.push(child) } }
  return node
}

const factory = new Function(
  'el',
  'CLASS',
  [
    'var INLINE_FILE_LIMIT = 4;',
    grab(clientSrc, 'displayPath'),
    grab(clientSrc, 'fileHintText'),
    grab(clientSrc, 'impactMenuLines'),
    grab(clientSrc, 'impactMenuBlock'),
    'return { INLINE_FILE_LIMIT, displayPath, fileHintText, impactMenuLines, impactMenuBlock };',
  ].join('\n'),
)
const { INLINE_FILE_LIMIT, displayPath, fileHintText, impactMenuLines, impactMenuBlock } = factory(el, realClass)

// 记录每次调用的 key 与参数，便于断言用的是哪种文案。
const t = (key, params) => (params === undefined ? `[${key}]` : `[${key}${JSON.stringify(params).replace(/[[\]"]/g, ' ').trim() ? ' ' + Object.values(params).join(',') : ''}]`)

const restore = (path) => ({ path, action: 'restore' })
const remove = (path) => ({ path, action: 'delete' })

console.log('0) 路径显示：工作区内转相对路径，工作区外保持绝对路径')
{
  const cwd = 'C:\\Data\\Project\\demo'
  check(displayPath('C:\\Data\\Project\\demo\\src\\a.ts', cwd) === 'src/a.ts', '工作区内 → 相对路径')
  check(displayPath('C:\\Data\\Project\\demo\\src\\a.ts', 'C:/Data/Project/demo/') === 'src/a.ts', 'cwd 的反斜杠/尾分隔符不影响判定')
  check(displayPath('D:\\other\\b.ts', cwd) === 'D:\\other\\b.ts', '工作区外 → 保持绝对路径')
  check(displayPath('C:\\Data\\Project\\demo2\\x.ts', cwd) === 'C:\\Data\\Project\\demo2\\x.ts',
    '前缀相近但不是子路径（demo2）也不误判')
  check(displayPath('C:\\Data\\Project\\demo\\a.ts', undefined) === 'C:\\Data\\Project\\demo\\a.ts',
    '宿主没给 cwd（旧版本）→ 原样显示')
  check(displayPath('C:\\Data\\Project\\demo\\a.ts', '') === 'C:\\Data\\Project\\demo\\a.ts', 'cwd 为空串 → 原样显示')
  check(displayPath('/home/u/w/a.ts', '/home/u/w') === 'a.ts', 'POSIX 路径同样生效')
}

console.log('1) 「回退对话和文件」的副标题给出文件数量')
{
  check(fileHintText([restore('a.ts')], t) === '[popover.both.hint.file]', '单个文件用单数文案')
  check(fileHintText([restore('a.ts'), remove('b.ts')], t) === '[popover.both.hint.files 2]', '多个文件带 {count}=2')
  check(/popover\.both\.hint\.files/.test(fileHintText(Array.from({ length: 12 }, (_, i) => restore(`f${i}.ts`)), t)),
    '12 个文件仍只报数量，不逐条塞进副标题')
}

console.log('2) 逐条列出受影响路径（还原 / 删除分别本地化）')
{
  const { lines, hidden } = impactMenuLines([restore('a.ts'), remove('b.ts')], t)
  check(lines.length === 2 && hidden === 0, '两条路径全部展开', JSON.stringify(lines))
  check(lines[0] === '[popover.impact.restore a.ts]', 'action=restore → 还原文案', lines[0])
  check(lines[1] === '[popover.impact.delete b.ts]', 'action=delete → 删除文案', lines[1])
  check(!/undefined|undefined/.test(lines.join('\n')), '路径都插进了模板（没有 {path} 残留）')
}

console.log('3) 超过上限折叠，余量汇总（确认页仍全列，不在本函数里）')
{
  const many = Array.from({ length: 9 }, (_, i) => restore(`f${i}.ts`))
  const { lines, hidden } = impactMenuLines(many, t)
  check(lines.length === INLINE_FILE_LIMIT, `只展开前 ${INLINE_FILE_LIMIT} 条`, String(lines.length))
  check(hidden === 9 - INLINE_FILE_LIMIT, '余量 = 总数 - 上限', String(hidden))
  const custom = impactMenuLines(many, t, 2)
  check(custom.lines.length === 2 && custom.hidden === 7, 'limit 可覆盖（调用方显式传入）', JSON.stringify(custom.hidden))
  const zero = impactMenuLines(many, t, 0)
  check(zero.lines.length === 0 && zero.hidden === 9, 'limit=0 全部折叠，不报负数', String(zero.hidden))
}

console.log('4) 内联区块：类名、more 文案、快照关闭提示')
{
  const block = impactMenuBlock([restore('a.ts')], t, false)
  check(block.length === 1, '快照开启时只有一个区块', String(block.length))
  check(block[0].className === 'dsh-rewind-popover-files', '区块用独立类名（不挤占确认页的 impact 面板）', block[0].className)
  check(block[0].text === '[popover.impact.restore a.ts]', '区块文本是路径行', block[0].text)

  const many = Array.from({ length: 7 }, (_, i) => restore(`f${i}.ts`))
  const folded = impactMenuBlock(many, t, false)
  check(folded[0].children.length === 1, '折叠时追加一行 more 提示', String(folded[0].children.length))
  check(folded[0].children[0].className === 'dsh-rewind-popover-note', 'more 行用 note 小字')
  check(folded[0].children[0].text === '[popover.files.more 3]', 'more 行带 {count}=3', folded[0].children[0].text)

  const off = impactMenuBlock([restore('a.ts')], t, true)
  check(off.length === 2 && off[1].text === '[popover.backupDisabled]', '快照关闭时追加提示', JSON.stringify(off[1]?.text))
  check(impactMenuBlock([], t, true).length === 0, '没有文件就不渲染空的区块')
}

console.log('5) 模式菜单把预览结果接进渲染（不是只在确认页用）')
{
  const modes = clientSrc.slice(clientSrc.indexOf('const renderModes = () => {'), clientSrc.indexOf('const renderImpact = () => {'))
  check(/impactMenuBlock\(files/.test(modes), 'renderModes 调用 impactMenuBlock')
  check(/fileHintText\(files, t\)/.test(modes), '副标题换成数量')
  check(/bothState\.state === "hasChanges" \? bothState\.files : \[\]/.test(modes),
    '只有 hasChanges 才取 files（loading/error 下不渲染旧数据）')
  check(/files: outcome\.files/.test(clientSrc), 'state 上保存 files')
  check(/backupOff: outcome\.backupOff/.test(clientSrc), 'state 上保存 backupOff')
  check(/impactMenuBlock\(files, t, bothState\.backupOff === true, bothState\.cwd\)/.test(clientSrc), '把 cwd 传给内联区块')
  check(/displayPath\(file\.path, outcome\.cwd\)/.test(clientSrc), '确认页同样走 displayPath')
  check(/typeof value\["cwd"\] === "string"/.test(clientSrc), 'RPC 解码带出 cwd（旧宿主缺省 undefined）')
}

console.log('6) 三语齐全（每个键都必须有 en/zh/ja 三条定义）')
{
  for (const key of ['popover.both.hint.file', 'popover.both.hint.files', 'popover.files.more']) {
    const n = (clientSrc.match(new RegExp('"' + key.replace(/\./g, '\\.') + '": ', 'g')) ?? []).length
    check(n === 3, `${key} 有 en/zh/ja 三条定义`, String(n))
  }
  for (const key of ['popover.both.hint.files', 'popover.files.more']) {
    const re = new RegExp('"' + key.replace(/\./g, '\\.') + '": "((?:[^"\\\\]|\\\\.)*)"', 'g')
    const decoded = [...clientSrc.matchAll(re)]
      .map((m) => JSON.parse('"' + m[1] + '"'))
      .filter((text) => /[\u4e00-\u9fff]/.test(text) || /[\u3040-\u30ff]/.test(text))
    check(decoded.length === 2, `${key} 有中文与日文两条非英文定义`, String(decoded.length))
    for (const text of decoded) {
      check(text.includes('{count}'), `${key} 保留 {count} 占位符`, text.slice(0, 24))
    }
  }
  for (const key of ['popover.both.hint.file', 'popover.both.hint.files']) {
    const defs = [...clientSrc.matchAll(new RegExp('"' + key.replace(/\./g, '\\.') + '": "((?:[^"\\\\]|\\\\.)*)"', 'g'))]
    check(defs.length === 3, `${key} 三条定义都能被解析`, String(defs.length))
  }
}

console.log('7) 内联区块有样式（没有 CSS 会退化成一段裸文本）')
{
  check(clientSrc.includes('.dsh-rewind-popover-files {'), '样式表包含 .dsh-rewind-popover-files')
  const cls = clientSrc.slice(clientSrc.indexOf('var CLASS = {'), clientSrc.indexOf('};', clientSrc.indexOf('var CLASS = {')))
  check(/popoverFiles: "dsh-rewind-popover-files"/.test(cls), 'CLASS 表登记了 popoverFiles')
  check(/max-height: 96px;[\s\S]{0,40}overflow: auto;/.test(clientSrc), '区块限高可滚动（长路径不把菜单撑爆）')
}

console.log('')
console.log(fail === 0 ? `全部通过（${pass} 项）` : `失败 ${fail} 项 / 共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)
