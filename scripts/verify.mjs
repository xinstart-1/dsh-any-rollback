#!/usr/bin/env node
/**
 * verify.mjs — confirm an installed (or unpacked) copy really carries the patch.
 *
 * Usage:
 *   node scripts/verify.mjs                       # checks the desktop profile install
 *   node scripts/verify.mjs <package-dir>         # checks any unpacked package dir
 *
 * Exits 1 on any mismatch, so it works as a post-install smoke test.
 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The patched 0.19.1 artifact this repository ships. */
const EXPECTED = {
  version: '0.19.1',
  files: {
    'lib/index.js': 'cd386603cc41df3f3ddae1b8a34a11cb5a4033a365521ddd6adf9db39fe4f7a3',
    'lib/artifact-track.js': '4092da093da213ae7161381d276d75df7c7fc6c5ea46ac0e6f7c80a628e8239a',
    'lib/client.js': '654e6e33f36d5c9ad998e3bb3b1720f1ab24886ab9271a7d02a5bd526e7fe313',
  },
}

const target = resolve(
  process.argv[2] ?? join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-rewind-plugin'),
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
  console.error(`FAIL cannot read ${join(target, 'package.json')}: ${error.message}`)
  process.exit(1)
}

console.log(`checking ${target}`)
report(pkg.name === 'dsh-rewind-plugin', 'package name', pkg.name)
report(pkg.version === EXPECTED.version, 'package version', `${pkg.version} (expected ${EXPECTED.version})`)

for (const [file, expected] of Object.entries(EXPECTED.files)) {
  const path = join(target, file)
  try {
    await stat(path)
    const actual = await sha256(path)
    report(actual === expected, file, actual === expected ? 'patched' : `digest ${actual}`)
  } catch {
    report(false, file, 'missing')
  }
}

const marker = await readFile(join(target, 'lib/index.js'), 'utf8').catch(() => '')
report(marker.includes('ArtifactTracker'), 'lib/index.js carries ArtifactTracker')

console.log(failed === 0 ? '\nPASS — patched build installed' : `\nFAIL — ${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)