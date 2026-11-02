// identity check: the four places DSH keys the plugin on must name the same
// package, and the durable internal ids must stay untouched.
import { readFile } from 'node:fs/promises'

const root = new URL('..', import.meta.url)
const read = (p) => readFile(new URL(p, root), 'utf8')

const pkg = JSON.parse(await read('package.json'))
const client = await read('lib/client.js')
const host = await read('lib/index.js')
const patch = await read('cordis.patch.yml')

const grab = (re, text) => (text.match(re) ?? [])[1]

const sites = {
  'package.json name': pkg.name,
  'client __ModuleLoader__ id': grab(/id: "([^"]+)"/, client),
  PLUGIN_PACKAGE: grab(/PLUGIN_PACKAGE = "([^"]+)"/, client),
  SETTINGS_ENTRY_ID: grab(/SETTINGS_ENTRY_ID = "([^"]+)"/, client),
  'cordis.patch.yml row id': grab(/- id: ([^\n]+)/, patch)?.trim(),
  'cordis.patch.yml row name': grab(/name: '([^']+)'/, patch),
}

const names = new Set(Object.values(sites))
console.log('身份位置:')
for (const [k, v] of Object.entries(sites)) console.log(`  ${k.padEnd(28)} ${v}`)
console.log(names.size === 1 ? `\nOK 全部一致: "${[...names][0]}"` : `\nMISMATCH: ${[...names].join(' vs ')}`)

const durable = {
  REWIND_MARKER_KIND: '"dsh-rewind"',
  SNAPSHOT_DIR_NAME: '"rewind-snapshots"',
  REWIND_RPC_CHANNEL: '"/dsh-rewind"',
}
console.log('\n内部标识（必须保持不变，保证旧数据可读）:')
let bad = 0
for (const [k, v] of Object.entries(durable)) {
  const ok = host.includes(`${k} = ${v}`)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${k} = ${v}`)
}

process.exit(names.size === 1 && bad === 0 ? 0 : 1)
