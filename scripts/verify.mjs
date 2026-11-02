#!/usr/bin/env node
/**
 * verify.mjs — 校验已安装（或已解包）的 dsh-any-rollback 是否为发布版本。
 *
 * 用法:
 *   node scripts/verify.mjs                       # 默认检查桌面 profile 的安装
 *   node scripts/verify.mjs <包目录>               # 检查任意解包目录
 *
 * 任一项不符即退出码 1，可直接当作安装后的冒烟测试。
 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 本仓库发布的版本与各文件摘要。 */
const PACKAGE_NAME = 'dsh-any-rollback'
const EXPECTED = {
  version: '0.19.1-any.7',
  files: {
    'lib/index.js': 'e03701fde916b68390e632c2fc5150d8e76a6e9575d60250d5e768c52448f678',
    'lib/artifact-track.js': '1b7ecde22206c3aa94a687ffb77bfa9afe57a8e019105126299a8d8b93552392',
    'lib/client.js': '5ff6307708ae8f424eff9376d07eea3f1585c5ca66d10d7e7adb386d8ed8e1a7',
  },
}

const target = resolve(
  process.argv[2] ?? join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', PACKAGE_NAME),
)

const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')

let failed = 0
const report = (ok, label, detail) => {
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

let pkg
try {
  pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
} catch (error) {
  console.error(`FAIL 无法读取 ${join(target, 'package.json')}: ${error.message}`)
  process.exit(1)
}

console.log(`检查目录: ${target}`)
report(pkg.name === PACKAGE_NAME, '包名', pkg.name)
report(pkg.version === EXPECTED.version, '版本', `${pkg.version}（期望 ${EXPECTED.version}）`)

for (const [file, expected] of Object.entries(EXPECTED.files)) {
  const path = join(target, file)
  try {
    await stat(path)
    const actual = await sha256(path)
    report(actual === expected, file, actual === expected ? '一致' : `摘要 ${actual}`)
  } catch {
    report(false, file, '缺失')
  }
}

const marker = await readFile(join(target, 'lib/index.js'), 'utf8').catch(() => '')
report(marker.includes('ArtifactTracker'), 'lib/index.js 含 ArtifactTracker')

console.log(failed === 0 ? '\n通过 —— 安装的是发布版本' : `\n失败 —— ${failed} 项不符`)
process.exit(failed === 0 ? 0 : 1)
