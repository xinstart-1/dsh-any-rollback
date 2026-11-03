// 用真实会话日志验证宿主侧版本模型：从 command/run + command/done 判定哪些标记是 regen 产生的。
// 关键：真实落盘里没有 data.op，所以必须能从命令事件正确区分 regen / rewind 标记。
import { readFile } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'

function decompressAll(buf) {
  const idxs = []
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) idxs.push(i)
  }
  const chunks = []
  for (let k = 0; k < idxs.length; k++) {
    const start = idxs[k]
    const end = k + 1 < idxs.length ? idxs[k + 1] : buf.length
    try { chunks.push(zstdDecompressSync(buf.subarray(start, end))) } catch { /* 跳过坏帧 */ }
  }
  return Buffer.concat(chunks).toString('utf8')
}

// 与 lib/index.js 里的 regenerateMarkerSeqs 同逻辑（这里独立复刻，作为交叉验证）
function regenerateMarkerSeqs(events) {
  const names = new Map()
  const markers = new Set()
  for (const event of events) {
    if (event.type === 'command/run' && typeof event.data?.commandId === 'string') {
      names.set(event.data.commandId, event.data.name)
      continue
    }
    if (event.type !== 'command/done') continue
    if (event.data?.kind !== 'success') continue
    const marker = event.data.sourceEventSeq
    if (!Number.isSafeInteger(marker)) continue
    if (names.get(event.data.commandId) !== 'regen') continue
    markers.add(marker)
  }
  return markers
}

const SESSIONS = [
  ['session-0a61f77f（真实点 ↻ 的那次 regen）', 'session-0a61f77f-9f7f-4211-84ac-1422c6f87db8'],
  ['session-d7f7d49f（/rewind 产生的标记）', 'session-d7f7d49f-fa77-4462-9355-93ce4fb62812'],
]
const root = 'C:/Users/xx106/.dsh/sessions/--C-Data-Project-dsh-forks-dsh-rollback--'

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) { pass++; console.log('  ok   ' + label) }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')) }
}

for (const [label, dir] of SESSIONS) {
  console.log(`\n### ${label}`)
  const text = decompressAll(await readFile(`${root}/${dir}/session.v4.jsonl.zstd`))
  const events = text.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)

  const dshMarkers = events.filter((e) => e.type === 'user/message' && e.data?.source?.kind === 'dsh-rewind')
  const withDataOp = events.filter((e) => e.data && e.data.op !== undefined)
  const regenMarkers = regenerateMarkerSeqs(events)
  const regenMarkerEvents = dshMarkers.filter((m) => regenMarkers.has(m.seq))
  const rewindMarkerEvents = dshMarkers.filter((m) => !regenMarkers.has(m.seq))

  console.log(`  事件 ${events.length}；dsh-rewind 标记 ${dshMarkers.length}；带 data.op 的事件 ${withDataOp.length}`)
  console.log(`  → 判定为 regen 标记: ${regenMarkerEvents.map((m) => m.seq).join(',') || '（无）'}`)
  console.log(`  → 判定为 rewind 标记: ${rewindMarkerEvents.map((m) => m.seq).join(',') || '（无）'}`)

  check(withDataOp.length === 0, '真实日志里确实没有任何 data.op（旧模型必然失效）', String(withDataOp.length))

  for (const m of dshMarkers) {
    const isRegen = regenMarkers.has(m.seq)
    const cited = Array.isArray(m.sourceEventSeqs) ? m.sourceEventSeqs.flat(Infinity).filter(Number.isSafeInteger) : []
    console.log(`     marker seq=${m.seq} regen=${isRegen} startSeq=${m.surfaceOp?.startSeq} cited=${JSON.stringify(m.sourceEventSeqs)}`)
    check(Array.isArray(m.sourceEventSeqs), `marker ${m.seq}: sourceEventSeqs 在事件顶层（非 data 内）`)
    check(m.data.op === undefined, `marker ${m.seq}: data 里没有 op`, JSON.stringify(Object.keys(m.data)))
    check(cited.length > 0, `marker ${m.seq}: 展平后能拿到被遮蔽 seq`, JSON.stringify(cited))
    check(m.surfaceOp?.startSeq === cited[0], `marker ${m.seq}: surfaceOp.startSeq 与展平首项一致（回退点可靠）`, `${m.surfaceOp?.startSeq} vs ${cited[0]}`)
  }
}

// 交叉验证：那次真实 regen 必须被判为 regen，那次真实 /rewind 必须被判为 rewind
{
  const regenText = decompressAll(await readFile(`${root}/session-0a61f77f-9f7f-4211-84ac-1422c6f87db8/session.v4.jsonl.zstd`))
  const regenEvents = regenText.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const set = regenerateMarkerSeqs(regenEvents)
  check(set.has(42), '真实 regen 标记 seq=42 被正确识别', [...set].join(','))

  const rewindText = decompressAll(await readFile(`${root}/session-d7f7d49f-fa77-4462-9355-93ce4fb62812/session.v4.jsonl.zstd`))
  const rewindEvents = rewindText.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const set2 = regenerateMarkerSeqs(rewindEvents)
  check(!set2.has(597), '/rewind 标记 seq=597 未被误判为 regen', [...set2].join(',') || '（空集）')
}

console.log('')
console.log(fail === 0 ? `全部通过（${pass} 项）` : `失败 ${fail} 项 / 共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)