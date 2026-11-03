// 版本显示切换的纯逻辑测试：从 client.js 抽出 annotateVersionCuts / isAnchorVisibleInCut，
// 验证「被遮蔽区间默认隐藏、只有选中某版时该版区间才可见」。
// 回归来源（真实日志 session-0a61f77f）：旧模型把「最后一版」的区间默认设为可见，
// 单次回退/重生成后旧回答照常显示 ——「回退后，上面的会话没有消失」。
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

const factory = new Function(
  grab('annotateVersionCuts') + '\n' + grab('isAnchorVisibleInCut') +
  '\nreturn { annotateVersionCuts, isAnchorVisibleInCut }'
)
const { annotateVersionCuts, isAnchorVisibleInCut } = factory()

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) { pass++; console.log('  ok   ' + label) }
  else { fail++; console.log('  FAIL ' + label + (detail ? ` — ${detail}` : '')) }
}

// 真实形状：同一提示词 #10 被 regenerate 两次
//   v1: 标记 #42 覆盖 [10..35]；v2: 标记 #61 覆盖 [10..60]
const rawCuts = [
  { target: 10, marker: 42 },
  { target: 10, marker: 61 },
]
const cuts = annotateVersionCuts(rawCuts)
console.log('1) 版本编号')
check(cuts.length === 2, '两个版本', String(cuts.length))
check(cuts[0].index === 1 && cuts[0].total === 2, '第 1 版 total=2', JSON.stringify(cuts[0]))
check(cuts[1].index === 2 && cuts[1].total === 2, '第 2 版 total=2', JSON.stringify(cuts[1]))
check(cuts[0].nextTarget === 61, '第 1 版的下一版起点 = 61', String(cuts[0].nextTarget))
check(cuts[1].nextTarget === void 0, '最后一版没有 nextTarget')

console.log('2) 默认（selected 未设置）：一切被遮蔽区间都隐藏')
check(isAnchorVisibleInCut(cuts[1], 10, void 0) === false, '默认：提示词 #10（区间内）隐藏')
check(isAnchorVisibleInCut(cuts[1], 50, void 0) === false, '默认：最后一版区间内的回答隐藏')
check(isAnchorVisibleInCut(cuts[0], 30, void 0) === false, '默认：旧版本区间隐藏')

console.log('3) 切到第 1 版：旧回答重新可见，新版区间隐藏')
{
  check(isAnchorVisibleInCut(cuts[0], 10, 1) === true, 'v1：提示词 #10 可见')
  check(isAnchorVisibleInCut(cuts[0], 30, 1) === true, 'v1：旧回答(anchor 30) 可见 ← 这是「切回旧版」的关键')
  check(isAnchorVisibleInCut(cuts[0], 61, 1) === false, 'v1：下一版标记之后隐藏')
  check(isAnchorVisibleInCut(cuts[1], 61, 1) === false, 'v1：第 2 版区间隐藏')
}

console.log('4) 切到第 2（最新）版：v1 区间隐藏、v2 区间可见')
{
  check(isAnchorVisibleInCut(cuts[1], 10, 2) === true, 'v2：提示词 #10 可见')
  check(isAnchorVisibleInCut(cuts[1], 50, 2) === true, 'v2：其回答区间可见')
  check(isAnchorVisibleInCut(cuts[0], 30, 2) === false, 'v2：第 1 版区间隐藏')
}

console.log('5) 越界保护：selected 超出范围被夹到合法区间')
{
  check(isAnchorVisibleInCut(cuts[1], 30, 99) === true, 'selected=99 夹到最后一版')
  check(isAnchorVisibleInCut(cuts[0], 30, 99) === false, 'selected=99 时第 1 版仍隐藏')
  check(isAnchorVisibleInCut(cuts[0], 30, 0) === true || isAnchorVisibleInCut(cuts[0], 30, 0) === false, 'selected=0 不抛异常')
}

console.log('6) 不同提示词互不影响')
{
  const mixed = annotateVersionCuts([
    { target: 10, marker: 42 },
    { target: 10, marker: 61 },
    { target: 100, marker: 120 },
  ])
  const t10 = mixed.filter((c) => c.target === 10)
  const t100 = mixed.filter((c) => c.target === 100)
  check(t10.length === 2 && t10[1].index === 2 && t10[1].total === 2, '提示词 #10 有 2 版')
  check(t100.length === 1 && t100[0].index === 1 && t100[0].total === 1, '提示词 #100 只有 1 版')
  // 单版本（#100）：默认也隐藏 —— 区间内是已撤下的内容
  check(isAnchorVisibleInCut(t100[0], 110, void 0) === false, '单版本默认隐藏（回退后旧回答消失）')
  check(isAnchorVisibleInCut(t100[0], 110, 1) === true, '单版本选中 v1 时可见')
}

console.log('')
console.log(fail === 0 ? `全部通过（${pass} 项）` : `失败 ${fail} 项 / 共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)
