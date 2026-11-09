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

/**
 * 本仓库发布的版本与各文件摘要。
 *
 * 摘要按 **LF 归一后的内容** 计算，而不是磁盘字节。原因：同一个提交在 git
 * 仓库里是 LF，Windows 按 core.autocrlf 检出成 CRLF，`npm pack` 打的是检出后
 * 的字节——三者 sha256 各不相同。若按原始字节比对，换个平台或换个 agent 解包
 * 校验就会报"内容被篡改"，而实际只差换行符。归一后摘要只反映内容，走到哪里
 * 都成立。
 *
 * 因此：改完 lib/ 任一文件后，用 `npm run digest` 重新生成这三个值。
 */
const PACKAGE_NAME = 'dsh-any-rollback'
const EXPECTED = {
  version: '0.19.1-any.32',
  files: {
    'lib/index.js': '0cb856a53feee3e6e5b6556e49cfb18986c4217f09c4dd3ade5900a7fefcc506',
    'lib/artifact-track.js': '396d5003c00da1684476e2df1e5ed8450af4aaa1ae0bb6030547ec69163a8c42',
    'lib/client.js': 'c7712173296f6ca626ff733af4f48f8cda1fcab8faa5ac0b82daf1ef16fd0fdf',
  },
}

const target = resolve(
  process.argv[2] ?? join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', PACKAGE_NAME),
)

/** 文件内容的 sha256，先把 CRLF 归一成 LF —— 换行符不算内容。 */
const contentDigest = async (path) => {
  const raw = await readFile(path)
  const lf = Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
  return createHash('sha256').update(lf).digest('hex')
}

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
    const actual = await contentDigest(path)
    report(actual === expected, file, actual === expected ? '一致' : `摘要 ${actual}`)
  } catch {
    report(false, file, '缺失')
  }
}

const marker = await readFile(join(target, 'lib/index.js'), 'utf8').catch(() => '')
report(marker.includes('ArtifactTracker'), 'lib/index.js 含 ArtifactTracker')

console.log(failed === 0 ? '\n通过 —— 安装的是发布版本' : `\n失败 —— ${failed} 项不符`)
process.exit(failed === 0 ? 0 : 1)
