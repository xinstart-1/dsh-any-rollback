#!/usr/bin/env node
// 统一测试入口：顺序执行 tests/*.mjs（每个测试独立子进程），任一失败即整体失败。
//
// 约定：
//   - 退出码 0 = 通过；非 0 = 失败；单文件超过 120s = 失败（超时，强制结束）。
//   - 环境不可用而无法执行时，测试**必须**打印一行 `SKIP: <原因>` 并以 0 退出；
//     runner 把它计入 skipped（而不是 passed），并在汇总里显式列出原因。
//   - tests/ 下的辅助脚本不属于测试：以 `_` 开头的文件会被跳过（列出原因）；
//     runner 自身不计入。
//
// 用法：node tests/run-all.mjs            # 跑全部
//      node tests/run-all.mjs --filter=x  # 只跑文件名含 x 的测试（调试用）
import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TESTS_DIR = join(ROOT, 'tests')
const SELF = basename(fileURLToPath(import.meta.url))
const TIMEOUT_MS = 120_000
const MAX_BUFFER = 8 * 1024 * 1024
const TAIL_LINES = 15
// 显式跳过约定：行首 SKIP: 或 [SKIP]
const SKIP_RE = /^\s*(?:SKIP|\[SKIP\])\s*:?\s*(.+)$/gm

const filterArg = process.argv.find((a) => a.startsWith('--filter='))
const filter = filterArg === undefined ? undefined : filterArg.slice('--filter='.length)

const fmtDuration = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`)

// 从测试输出里提取 SKIP 原因（可多行，去重后以「；」连接）
function skipReasons(text) {
  const reasons = []
  for (const match of String(text).matchAll(SKIP_RE)) {
    const reason = match[1].trim()
    if (reason !== '' && !reasons.includes(reason)) reasons.push(reason)
  }
  return reasons
}

// 失败时只回放尾部，避免把整份输出灌进汇总
function tail(text, lines = TAIL_LINES) {
  const rows = String(text).replaceAll('\r', '').split('\n')
  while (rows.length > 0 && rows[rows.length - 1].trim() === '') rows.pop()
  return rows.slice(-lines)
}

const allFiles = (await readdir(TESTS_DIR))
  .filter((name) => name.endsWith('.mjs') && name !== SELF)
  .sort()

const files = []
const excluded = []
for (const name of allFiles) {
  if (name.startsWith('_')) {
    excluded.push({ file: name, reason: '辅助脚本（_ 前缀），不是测试' })
    continue
  }
  if (filter !== undefined && !name.includes(filter)) continue
  files.push(name)
}

console.log(`测试入口：tests/${SELF}`)
console.log(`顺序执行 ${files.length} 个测试文件（单文件超时 ${fmtDuration(TIMEOUT_MS)}）\n`)

const results = []
let passed = 0
let failed = 0
let skipped = 0

for (const name of files) {
  const rel = `tests/${name}`
  const started = performance.now()
  const result = spawnSync(process.execPath, [rel], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  })
  const elapsed = performance.now() - started
  const stdout = String(result.stdout ?? '')
  const stderr = String(result.stderr ?? '')
  const timedOut = result.error?.code === 'ETIMEDOUT'
  const exitCode = result.status === null ? null : result.status

  if (timedOut) {
    failed += 1
    results.push({ rel, status: 'fail', reason: `超时（>${fmtDuration(TIMEOUT_MS)}）`, stdout, stderr, elapsed })
    console.log(`  FAIL  ${rel}  (${fmtDuration(elapsed)}，超时)`)
    continue
  }
  if (exitCode !== 0) {
    failed += 1
    const detail = exitCode === null ? `被信号 ${result.signal ?? '?'} 终止` : `exit=${exitCode}`
    results.push({ rel, status: 'fail', reason: detail, stdout, stderr, elapsed })
    console.log(`  FAIL  ${rel}  (${fmtDuration(elapsed)}，${detail})`)
    continue
  }

  const reasons = skipReasons(stdout + '\n' + stderr)
  if (reasons.length > 0) {
    skipped += 1
    results.push({ rel, status: 'skip', reason: reasons.join('；'), stdout, stderr, elapsed })
    console.log(`  skip  ${rel}  (${fmtDuration(elapsed)}) — ${reasons.join('；')}`)
    continue
  }

  passed += 1
  results.push({ rel, status: 'pass', stdout, stderr, elapsed })
  console.log(`  ok    ${rel}  (${fmtDuration(elapsed)})`)
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
const failures = results.filter((r) => r.status === 'fail')
const skips = results.filter((r) => r.status === 'skip')
const total = results.length

console.log('')
console.log(
  `汇总：文件 ${total} 个 — 通过 ${passed}，跳过 ${skipped}，失败 ${failed}（总耗时 ${fmtDuration(
    results.reduce((sum, r) => sum + r.elapsed, 0),
  )}）`,
)

if (skips.length > 0) {
  console.log('\n跳过的文件与原因：')
  for (const r of skips) console.log(`  - ${r.rel} — ${r.reason}`)
}

if (excluded.length > 0) {
  console.log('\n未纳入测试套件：')
  for (const e of excluded) console.log(`  - tests/${e.file} — ${e.reason}`)
}

if (failures.length > 0) {
  console.log('\n失败的文件：')
  for (const r of failures) {
    console.log(`  - ${r.rel}（${r.reason}）`)
    const out = tail(r.stdout)
    const err = tail(r.stderr)
    for (const line of out) console.log(`      ${line}`)
    if (err.length > 0) {
      console.log('      ---- stderr ----')
      for (const line of err) console.log(`      ${line}`)
    }
  }
}

console.log(failed === 0 ? '\n全部通过' : `\n失败：${failed} 个文件`)
process.exit(failed === 0 ? 0 : 1)
