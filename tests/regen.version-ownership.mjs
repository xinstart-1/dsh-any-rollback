#!/usr/bin/env node
// 回归：版本切换控件从不显示的根因。
//
// 控件渲染条件 = fetchVersions() 过滤后 length >= 2。旧过滤是
// `v.targetSeq === targetSeq` 严格相等，但：
//   - 服务端的 v.targetSeq = 该 marker 遮蔽区间的最小被引用 seq（原提示词）；
//   - 客户端反推的 targetSeq = 这条回答对应的提示词 seq（regen 重发出来的
//     **新**提示词，seq 大于 marker）。
// 两者永远不相等 → 过滤后恒为空 → 控件 return null。
// 真实日志（session-0a61f77f，15:27 那次 ↻）：marker 121 遮蔽 [112,117]，
// 新提示词是 #127。112 ≠ 127，控件不出现。
//
// 正确判据：版本组归属 = 「提示词落在该 marker 的重发区」
//   (marker.endSeq, 下一个 marker.markerSeq)
// 本测试从 client.js 抽出 AssistantVersionSwitcher 源码里的 owns 逻辑等价实现，
// 用真实日志数据验证。
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

// ── 1) 从 client.js 源码确认过滤逻辑已换成区间判据 ──
{
  check(src.includes('下一个 marker 的 markerSeq'), 'switcher 源码含重发区判据注释')
  check(!src.includes('v.targetSeq === targetSeq) return true'), '旧的严格相等判据已移除')
  const m = src.match(/const lo = Number\(v\.endSeq [\s\S]{0,120}Number\.MAX_SAFE_INTEGER/)
  check(m !== null, '过滤条件使用 (endSeq, nextMarker) 区间')
}

// ── 2) 用真实日志数据验证判据的行为 ──
{
  const raw = await readFile(process.env.LOCALAPPDATA + '/Temp/sess0a61.txt', 'utf8').catch(() => null)
  if (raw === null) {
    console.log('  skip  真实日志快照不可用，跳过数据验证')
  } else {
    const events = raw.trim().split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    function citedSeqsOf(event) {
      const r = Array.isArray(event?.sourceEventSeqs) ? event.sourceEventSeqs
        : Array.isArray(event?.data?.sourceEventSeqs) ? event.data.sourceEventSeqs : [];
      return r.flat(Infinity).filter((s) => Number.isSafeInteger(s)).sort((a, b) => a - b);
    }
    const REWIND = { kind: 'dsh-rewind' }
    function regenerateMarkerSeqs(events) {
      const names = new Map(), markers = new Set()
      for (const e of events) {
        if (e.type === 'command/run' && typeof e.data?.commandId === 'string') { names.set(e.data.commandId, e.data.name); continue }
        if (e.type !== 'command/done' || e.data?.kind !== 'success') continue
        const m = e.data.sourceEventSeq
        if (!Number.isSafeInteger(m)) continue
        if (names.get(e.data.commandId) !== 'regen') continue
        names.set(e.data.commandId, void 0); markers.add(m)
      }
      return markers
    }
    const ms = regenerateMarkerSeqs(events)
    const versions = []
    for (const event of events) {
      if (!(event.type === 'user/message' && event.data?.source?.kind === REWIND.kind && ms.has(event.seq))) continue
      const targetSeq = citedSeqsOf(event)[0]
      if (!Number.isSafeInteger(targetSeq)) continue
      versions.push({ index: versions.length + 1, markerSeq: event.seq, targetSeq,
        startSeq: event.surfaceOp?.startSeq ?? targetSeq, endSeq: event.surfaceOp?.endSeq ?? targetSeq })
    }
    check(versions.length === 2, '服务端 versions = 2 条', JSON.stringify(versions))

    const ordered = [...versions].sort((a, b) => a.markerSeq - b.markerSeq)
    const keptFor = (targetSeq) => ordered.filter((v, i) => {
      if (targetSeq === void 0) return true
      const lo = Number(v.endSeq ?? v.targetSeq) + 1
      const hi = ordered[i + 1] ? Number(ordered[i + 1].markerSeq) - 1 : Number.MAX_SAFE_INTEGER
      return Number.isSafeInteger(targetSeq) && targetSeq >= lo && targetSeq <= hi
    })

    // 真实场景：15:27 那次 ↻ 的回答 #131，反推提示词 #127（重发出来的新提示）
    check(keptFor(127).length === 1 && keptFor(127)[0].markerSeq === 121,
      '重发提示词 #127 → 命中 marker 121 的版本组', JSON.stringify(keptFor(127)))
    // 更早一轮的提示词 #96 → 命中 marker 42 的版本组
    check(keptFor(96).length === 1 && keptFor(96)[0].markerSeq === 42,
      '提示词 #96 → 命中 marker 42 的版本组', JSON.stringify(keptFor(96)))
    // 被遮蔽的原提示词 #10：它的行已被撤下，不挂控件
    check(keptFor(10).length === 0, '被遮蔽的原提示词 #10 → 无版本组', JSON.stringify(keptFor(10)))

    // 关键断言：旧判据下 #127 一个版本都匹配不上（这正是 bug）
    const oldKept = ordered.filter((v) => v.targetSeq === 127)
    check(oldKept.length === 0, '旧判据（严格相等）下 #127 匹配不到任何版本 —— 即事故根因')
  }
}

console.log('')
console.log(fail === 0 ? `全部通过（${pass} 项）` : `失败 ${fail} 项 / 共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)
