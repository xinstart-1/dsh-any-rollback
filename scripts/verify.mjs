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
  version: '0.19.1-any.31',
  files: {
    'lib/index.js': 'b4aeb28dbde457d74e620c0e69ec6d3049a3aa5e7ffb02d54b15ec3c2fd3359e',
    'lib/artifact-track.js': 'bfa582690acfeb2aa90d0fc9fe04c9d37dda764d156f71695e5ce83791fbcb80',
    'lib/client.js': 'c312cd5c2d570dbfd456ccf1976993c1f40571b776c3e8363e0d44a42d1e6584',
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
