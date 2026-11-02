# dsh-rollback · artifact patch for dsh-rewind-plugin 0.19.1

> `dsh-rollback` is an unofficial repack of [`dsh-rewind-plugin`](https://github.com/SiriLee/dsh-rewind)
> **0.19.1** with an artifact-tracking patch, for DSH harness on the **0.2.1 line**.
> It is a separate package (not a replacement under the upstream name), so both can be installed side by side.
> Not affiliated with the upstream author. MIT, same as upstream — see [License](#license).

## Why this exists

The upstream `main` line (0.20.0-alpha.1) requires DSH `>=0.2.2-alpha.2`; on the 0.2.1 line the plugin is
refused at load time. 0.19.1 is the last release that runs there — but 0.19.1 does not track files that
commands produce, which is exactly what agent work tends to leave behind.

| Version | `engines.dsh` | Runs on DSH 0.2.1-rc.5 |
| --- | --- | --- |
| `0.19.1` (this repo, patched) | `>=0.2.1-rc.1 <0.3.0-0` | yes |
| `0.20.0-alpha.1` (upstream) | `>=0.2.2-alpha.2 <0.3.0-0` | no — refused at load |

When your harness reaches the 0.2.2 line, switch back to upstream; this repository is a stop-gap.

## What the patch changes

**The gap.** Upstream tracks two tools only — a file becomes restorable by being handled by `write` or
`edit` at least once. Anything a command produces (`node render.mjs`, `ffmpeg`, a build or data script)
never joins that list, so a rewind leaves it alone: a file that did not exist at the target state stays on
disk, and a file whose bytes changed keeps the newer bytes while the rewind reports "no restorable
changes". These files are also usually far above the 8 MiB `maxFileBytes` cap, which is never even
consulted for them. Upstream documents this as *Limitation 1* in
[`docs/compat/tracking-boundary.md`](https://github.com/SiriLee/dsh-rewind/blob/main/docs/compat/tracking-boundary.md)
and deliberately accepts it.

**What the patch does.** At each turn boundary it writes a manifest of the workspace
(`path → size + mtime + sha256`) and caches content **only for entries that changed**, keyed by digest, so
re-rendering identical bytes costs nothing. On a rewind:

| At the target state | Now | Action |
| --- | --- | --- |
| existed, content cached | different or missing | restore the cached bytes |
| absent | exists (a command created it) | move to `quarantine/`, record the destination in `index.json` |
| existed, content not cached (large / uncached) | different or missing | move to `quarantine/`, report "regenerate if needed" |

Quarantine is a move, never a delete: the bytes are kept under the snapshot root and listed in
`index.json` so they can be recovered by hand.

### Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `artifactTrackingEnabled` | `true` | master switch |
| `artifactMaxFileBytes` | `67108864` (64 MiB) | per-file cache cap, independent of `maxFileBytes` |
| `artifactBaselineContent` | `false` | also cache the first observation (enables restoring pre-existing content the plugin never saw) |
| `artifactExclude` | `node_modules,.git,dist,build,out,.next,.nuxt,.cache,.turbo,coverage,__pycache__,venv,.venv,target` | subtree names skipped |
| `artifactKeepManifests` | `20` | manifests kept per session |

### Storage

```
<snapshotDir>/<sessionId>/artifacts/
  manifests/<seq>.json      # one manifest per turn boundary
  quarantine/               # moved-out files
  quarantine/index.json     # where every quarantined file came from
```

`<snapshotDir>` is the plugin's existing `snapshotDir` (`~/.dsh/rewind-snapshots/` by default), so
cleaning that directory still removes everything this patch stores.

## Install

### A. From this repository's release tarball (recommended)

In `~/.dsh/profiles/<profile>/package.json`:

```json
"dependencies": {
  "dsh-rollback": "https://github.com/xinstart-1/dsh-rollback/releases/download/v0.19.1-rb.1/dsh-rollback-0.19.1.tgz"
}
```

then install and restart DSH:

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
& $node $pnpm install --dir "$env:USERPROFILE\.dsh\profiles\<profile>" --prefer-offline
```

Make sure `dsh-rollback` is also listed in that profile's `dsh.profile.bundles` array — that array is what
actually loads the plugin. Remove `dsh-rewind-plugin` from both places if it is still there: a row and a
dependency can stay mounted together, but two copies of the same rewind UI would both render a ↶ button.

### B. From a clone

```json
"dsh-rollback": "file:C:/path/to/dsh-rollback/dist/dsh-rollback-0.19.1.tgz"
```

### C. Patch a pristine upstream `dsh-rewind-plugin@0.19.1` install

Not supported after the rename. The harness resolves the client half with
`require.resolve('<package-name>/package.json')`, so the directory under `node_modules` must be named after
the package; a package called `dsh-rollback` cannot live in a `dsh-rewind-plugin` directory. Install from the
tarball (A) or a clone (B), and use `scripts/refresh.ps1` to re-sync an existing `dsh-rollback` copy.

## Verify

```powershell
node scripts\verify.mjs                                            # default: desktop profile
node scripts\verify.mjs "C:\path\to\node_modules\dsh-rollback"
```

Expected digests (SHA-256):

| File | SHA-256 |
| --- | --- |
| `lib/index.js` | `cd386603cc41df3f3ddae1b8a34a11cb5a4033a365521ddd6adf9db39fe4f7a3` |
| `lib/artifact-track.js` | `03e8ddab92765bf8a53522495b0b657235c327cb94b01d88ff7fe46bd9ba7b6c` |
| `lib/client.js` | `5d29b0fa28577bcf8d2c0425029016f18a63efcdfbe138ac0b6d07f21c766461` |
| `dist/dsh-rollback-0.19.1.tgz` | `0e0bd8f9ad4a79aeb382b15fa29e8dac27b95552b6d17249dea5c931e74cb46f` |

Runtime proof after a restart: run one turn, then check that
`~/.dsh/rewind-snapshots/<sessionId>/artifacts/manifests/` exists. The ↶ button should be back too.

## Rollback / upgrade

| Goal | Do |
| --- | --- |
| back to the plain upstream plugin | dependency `"dsh-rewind-plugin": "0.19.1"` (registry) or `"0.20.0-alpha.1"` once the harness allows it, drop `dsh-rollback`, then reinstall |
| keep snapshots, drop artifact data only | delete `<snapshotDir>/<sessionId>/artifacts/` |
| move to upstream 0.20 when the harness allows it | this patch is **not** in upstream; 0.20.0 also has no artifact tracking |

## What differs from the published 0.19.1

| Path | Change |
| --- | --- |
| `lib/index.js` | patched: `ArtifactTracker` import, 5 config keys, `turn/end` hook, `previewImpact` merge, `executeRewind` restore/quarantine, `apply()` wiring — the exact diff is [`patch/artifact-patch.diff`](patch/artifact-patch.diff) (10 hunks) |
| `lib/artifact-track.js` | new module (16.9 KB), source of truth also kept at [`patch/artifact-track.js`](patch/artifact-track.js) |
| `package.json` | renamed to `dsh-rollback`; `scripts.prepare` removed, so an install never tries to run a build that is not shipped. |
| `cordis.patch.yml`, `lib/client.js` | the loader row and the client/entry identity constants renamed with the package (see below). |

The package name is `dsh-rollback`, and it **must** match in four places at once: `package.json` `name`,
the `cordis.patch.yml` loader row (`id` + `name`), the `__ModuleLoader__.load({ id })` registration in
`lib/client.js`, and the compiled `PLUGIN_PACKAGE` / `SETTINGS_ENTRY_ID` constants. The harness keys the
client graph row, the `plugins.bundle.config` slot and the settings entry by that one name — if any of the
four drifts, the ↶ button and the settings card disappear silently.

The **internal** identifiers are deliberately left with the upstream name, so existing data stays readable:
the session marker kind `dsh-rewind`, the snapshot directory `rewind-snapshots`, the RPC channel
`/dsh-rewind`, and the CSS class prefix `dsh-rewind-`.

Renaming the package does drop the old settings document: the harness stores configuration under the entry
id, so settings saved for `dsh-rewind-plugin` are not read by the renamed entry. Re-set them once on the
Plugins page; stored snapshots are unaffected.

## Caveats

- 0.19.1 is the legacy line; upstream keeps no cross-version compatibility, so this fork will not track
  future harness changes.
- The patch is applied at the **built artifact** level (upstream's source does not contain it). Reinstalling
  the upstream package from the npm registry gets you the unpatched plugin again — reinstall this tarball
  instead, or run `scripts/refresh.ps1` to re-sync an existing `dsh-rollback` directory.
- The content cache stores plaintext copies of changed files under the snapshot root; that is the same
  trust boundary the plugin's own backups already use, but it is more data on disk. Bound it with
  `artifactMaxFileBytes` / `artifactExclude`.
- Upstream treats the tracking boundary as a deliberate design decision, so this may never land upstream.
  It is maintained here as a local bypass.

## Repository layout

```
dist/     the installable tarball (release asset)
package/  the same package unpacked, for review and diffing
patch/    the artifact diff + the new module's source
scripts/  verify.mjs (integrity check), refresh.ps1 (re-sync an installed copy)
```

## License

MIT. Upstream plugin © SiriLee ([SiriLee/dsh-rewind](https://github.com/SiriLee/dsh-rewind)); the
artifact-tracking patch and this packaging are released under the same MIT terms. See [LICENSE](LICENSE).