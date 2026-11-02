# dsh-rewind-plugin · artifact patch (0.19.1)

> Unofficial repack of [`dsh-rewind-plugin`](https://github.com/SiriLee/dsh-rewind) **0.19.1** with an
> artifact-tracking patch, for DSH harness on the **0.2.1 line**.
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
  "dsh-rewind-plugin": "https://github.com/<owner>/<repo>/releases/download/v0.19.1-artifact-patch.1/dsh-rewind-plugin-0.19.1-artifact-patched.tgz"
}
```

then install and restart DSH:

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
& $node $pnpm install --dir "$env:USERPROFILE\.dsh\profiles\<profile>" --prefer-offline
```

Make sure `dsh-rewind-plugin` is also listed in that profile's `dsh.profile.bundles` array — that array is
what actually loads the plugin.

### B. From a clone

```json
"dsh-rewind-plugin": "file:C:/path/to/dsh-rewind-artifact-patch/dist/dsh-rewind-plugin-0.19.1-artifact-patched.tgz"
```

### C. Patch a pristine `npm i dsh-rewind-plugin@0.19.1` install in place

```powershell
npm i dsh-rewind-plugin@0.19.1        # in the profile, or however you normally install it
.\scripts\apply-patch.ps1 -Target "C:\Users\<you>\.dsh\profiles\<profile>\node_modules"
```

## Verify

```powershell
node scripts\verify.mjs                                            # default: desktop profile
node scripts\verify.mjs "C:\path\to\node_modules\dsh-rewind-plugin"
```

Expected digests (SHA-256):

| File | SHA-256 |
| --- | --- |
| `lib/index.js` | `cd386603cc41df3f3ddae1b8a34a11cb5a4033a365521ddd6adf9db39fe4f7a3` |
| `lib/artifact-track.js` | `4092da093da213ae7161381d276d75df7c7fc6c5ea46ac0e6f7c80a628e8239a` |
| `lib/client.js` | `654e6e33f36d5c9ad998e3bb3b1720f1ab24886ab9271a7d02a5bd526e7fe313` |
| `dist/dsh-rewind-plugin-0.19.1-artifact-patched.tgz` | `0bd4ae10df22a474d90d649ced412c6c470d051c7be18b8bcbecede0b31d1de8` |

Runtime proof after a restart: run one turn, then check that
`~/.dsh/rewind-snapshots/<sessionId>/artifacts/manifests/` exists. The ↶ button should be back too.

## Rollback / upgrade

| Goal | Do |
| --- | --- |
| back to plain 0.19.1 | dependency `"dsh-rewind-plugin": "0.19.1"` (registry), then reinstall |
| keep snapshots, drop artifact data only | delete `<snapshotDir>/<sessionId>/artifacts/` |
| move to upstream 0.20 when the harness allows it | dependency `"dsh-rewind-plugin": "0.20.0-alpha.1"` — the patch is **not** in upstream |

## What differs from the published 0.19.1

| Path | Change |
| --- | --- |
| `lib/index.js` | patched: `ArtifactTracker` import, 5 config keys, `turn/end` hook, `previewImpact` merge, `executeRewind` restore/quarantine, `apply()` wiring — the exact diff is [`patch/artifact-patch.diff`](patch/artifact-patch.diff) (9 hunks) |
| `lib/artifact-track.js` | new module (16.9 KB), source of truth also kept at [`patch/artifact-track.js`](patch/artifact-track.js) |
| `package.json` | `scripts.prepare` removed, so an install never tries to run a build that is not shipped. Every other field is untouched — including the name. |

The package name **must** stay `dsh-rewind-plugin`: `cordis.patch.yml` inserts a loader row whose
`id`/`name` equal the package name (the client half resolves `require.resolve('<row-name>/package.json')`),
and `lib/client.js` hardcodes `PLUGIN_PACKAGE` / `SETTINGS_ENTRY_ID`. Renaming it would mean editing the
compiled client half and migrating the settings entry id, which is out of scope here.

## Caveats

- 0.19.1 is the legacy line; upstream keeps no cross-version compatibility, so this fork will not track
  future harness changes.
- The patch is applied at the **built artifact** level (upstream's source does not contain it). Reinstalling
  from the npm registry silently loses the patch — reinstall from this tarball, or re-run
  `scripts/apply-patch.ps1`.
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
scripts/  verify.mjs (integrity check), apply-patch.ps1 (patch an existing install)
```

## License

MIT. Upstream plugin © SiriLee ([SiriLee/dsh-rewind](https://github.com/SiriLee/dsh-rewind)); the
artifact-tracking patch and this packaging are released under the same MIT terms. See [LICENSE](LICENSE).