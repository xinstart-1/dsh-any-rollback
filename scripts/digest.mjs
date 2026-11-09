#!/usr/bin/env node
/**
 * digest.mjs — 重新计算 scripts/verify.mjs 里的内容摘要。
 *
 * 摘要按 LF 归一后的内容算（见 verify.mjs 顶部注释），所以本脚本与平台无关：
 * 在 Windows(CRLF 检出) 与 Linux(LF 检出) 上得到同样的值。
 *
 * 用法: node scripts/digest.mjs
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

const FILES = ['lib/index.js', 'lib/artifact-track.js', 'lib/client.js']

const digestOf = async (p) => {
  const raw = await readFile(p)
  const lf = Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
  return createHash('sha256').update(lf).digest('hex')
}

let verify = await readFile('scripts/verify.mjs', 'utf8')
const updates = {}

for (const f of FILES) {
  const d = await digestOf(f)
  updates[f] = d
  const escaped = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 匹配该文件那一行的摘要槽位（无论当前是占位符还是旧摘要）
  const re = new RegExp(`('${escaped}': ')[0-9a-f]{64}(')`)
  const rePlaceholder = new RegExp(`('${escaped}': ')[A-Z_0-9]+(')`)
  if (re.test(verify)) {
    verify = verify.replace(re, (_m, a, c) => a + d + c)
  } else if (rePlaceholder.test(verify)) {
    verify = verify.replace(rePlaceholder, (_m, a, c) => a + d + c)
  } else {
    throw new Error(`verify.mjs: no digest slot found for ${f}`)
  }
}

await writeFile('scripts/verify.mjs', verify)
for (const [f, d] of Object.entries(updates)) console.log(`${f}\n  ${d}`)
console.log('\nscripts/verify.mjs updated')
