# dsh-any-rollback

> **In-window conversation rewind for DSH.** Rewind to any earlier user message and restore the workspace
> with it — including files produced by commands (`node render.mjs`, `ffmpeg`, build and data scripts),
> not just source files handled by an editor tool. No session forking, no new window: the rewind happens
> in place.
>
> 中文版：[README.md](README.md)

## The problem

A turn of agent work usually leaves two kinds of traces: messages in the conversation, and files on disk.
"Go back to that step and try again" only works if both return to their earlier state — rewinding the
conversation alone leaves half-edited files behind, and restoring files alone leaves the model in the
wrong context.

`dsh-any-rollback` does both: click ↶ on a message and the conversation returns to just before it, with the
workspace restored to how it looked at that moment.

| Situation | Without this plugin | With it |
| --- | --- | --- |
| Three iterations of a render script, back to the first | clean up a pile of mp4 files by hand | one rewind restores them; newer files move to quarantine |
| A refactor went wrong | conversation rewinds, files stay broken | conversation and files return together |
| Several failed attempts, restart from one step | open a new session, lose context | rewind in place, same window |

## Features

### 1. Rewind the conversation by message

Every user message has a ↶ button. It withdraws everything after that message from the conversation view
(the session log stays append-only and fully auditable), and puts the withdrawn text back in the composer so
you can edit and resend.

Commands work too:

| Command | Effect |
| --- | --- |
| `/rewind <index>` | rewind to just before the Nth user message |
| `/rewind @<seq>` | rewind by in-session sequence number |
| `/undo` | revert the last rewind |

### 2. Restore workspace files at the same time

A rewind can restore the conversation only, the files only, or both. File restores read **only the plugin's
own backup directory** — it never guesses, and only writes back content it actually backed up.

### 3. Track files produced by commands (the part most tools miss)

Most implementations back up only files the model touched through `write` / `edit`. But agent work usually
produces files through commands: frame sequences from `node render.mjs`, a video muxed by `ffmpeg`, build
output in `dist/`, a data script's `*.parquet`. Nothing ever "edited" them, so conventional checkpoints
ignore them entirely.

This plugin writes a workspace manifest at each turn boundary (`path → size + mtime + sha256`) and caches
content **only for entries that changed**, keyed by digest, so re-rendering identical bytes costs nothing.
On a rewind it decides per file:

| At the target state | Now | Action |
| --- | --- | --- |
| existed, content cached | different or missing | restore the cached bytes |
| absent | exists (created by a command) | move to quarantine, never delete |
| existed, content not cached (too large / uncached) | different or missing | move to quarantine, report "regenerate if needed" |

**Quarantine only moves, never deletes**: bytes stay on disk with their origin recorded in `index.json`.
Losing a two-hour render to a rewind would be unacceptable, so the plugin spends disk space instead.

### 4. Automatic snapshot cleanup

Backups take space, so they are pruned by policy: an on/off switch, an idle-age cutoff, and a manual sweep.

| Command | Effect |
| --- | --- |
| `/snapshot-auto-cleanup` | show current status |
| `/snapshot-auto-cleanup on\|off` | enable / disable auto cleanup |
| `/snapshot-auto-cleanup max-age <days>` | set the idle cutoff |
| `/snapshot-auto-cleanup run [--apply]` | dry run, or actually sweep |
| `/snapshot-auto-cleanup run --current [--apply]` | sweep only this session |

### 5. Settings card

A dedicated card on the DSH Plugins page covers the backup switch and the cleanup policy, so no config file
editing is needed.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `fileCheckpointingEnabled` | `true` | record new file backups |
| `maxFileBytes` | `8388608` (8 MiB) | per-file backup cap; `0` disables it |
| `snapshotDir` | `~/.dsh/rewind-snapshots/` | backup root |
| `artifactTrackingEnabled` | `true` | track command-produced files |
| `artifactMaxFileBytes` | `67108864` (64 MiB) | per-file cache cap for artifacts, independent of `maxFileBytes` |
| `artifactBaselineContent` | `false` | also cache the first observation (costlier; restores large pre-existing content) |
| `artifactExclude` | `node_modules,dist,build,out,coverage,__pycache__,venv,.venv,target` | subtrees skipped while tracking |
| `artifactKeepManifests` | `20` | manifests kept per session |
| `autoCleanupEnabled` | `true` | automatic cleanup switch |
| `autoCleanupMaxAgeDays` | `30` | idle days before a backup may be swept |

## Where data lives

```
~/.dsh/rewind-snapshots/<sessionId>/
  <messageSeq>/          # per-message file backups
  artifacts/
    manifests/           # one workspace manifest per turn boundary
    quarantine/          # files moved out by a rewind
    quarantine/index.json # where each quarantined file came from
```

The backup root is a sibling of the workspace, never a subtree of it. Deleting it loses rewind history but
never touches project files.

## Install

### From the release (recommended)

In the profile's `package.json`:

```json
"dependencies": {
  "dsh-any-rollback": "https://github.com/xinstart-1/dsh-any-rollback/releases/download/v0.19.1-any.3/dsh-any-rollback-0.19.1-any.3.tgz"
}
```

Install and restart DSH:

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
& $node $pnpm install --dir "$env:USERPROFILE\.dsh\profiles\<profile>" --prefer-offline
```

Also make sure `dsh-any-rollback` is listed in that profile's `dsh.profile.bundles` array — that array is what
actually loads the plugin.

### From a local clone

```json
"dsh-any-rollback": "file:C:/path/to/dsh-any-rollback/dist/dsh-any-rollback-0.19.1-any.3.tgz"
```

## Requirements

| Item | Requirement |
| --- | --- |
| DSH | `>=0.2.1-rc.1 <0.3.0-0` |
| Node.js | `^22.19.0` or `>=24.0.0` |

## Verify the install

```powershell
node scripts\verify.mjs                                            # current desktop profile
node scripts\verify.mjs "C:\path\to\node_modules\dsh-any-rollback"      # any unpacked dir
```

Expected digests (SHA-256):

| File | SHA-256 |
| --- | --- |
| `lib/index.js` | `7a724f18eadc9adc5d46e8eb28a31d8e39e5a3ceb82b6201810683abc2b64f26` |
| `lib/artifact-track.js` | `f1b85503f74763eb2bfec82ced93ba39f1d9ac1508757cc5a2d7f056bbcac822` |
| `lib/client.js` | `c1fb688c119a3823b4b421a6588eb04966fe17834ecd9b75c14e964d18cf8a85` |
| `dist/dsh-any-rollback-0.19.1-any.3.tgz` | `1de8212766a08971a399e8f76d2be6741d5a63935a781075953631d4fef6f0a5` |

**Restart DSH** after installing (the host half loads once per process). Then run one turn and confirm a
manifest appeared under `~/.dsh/rewind-snapshots/<sessionId>/artifacts/manifests/` and the ↶ buttons show up.

## Uninstall

Remove `dsh-any-rollback` from the profile's `dependencies` and `dsh.profile.bundles`, then reinstall. Backup
data is not deleted automatically — remove `~/.dsh/rewind-snapshots/` to wipe it.

## Design decisions

- **Only write back what was backed up.** Prefer restoring less over overwriting with a guess.
- **Never delete a file.** Anything that must leave the worktree goes to quarantine.
- **The session log is append-only.** A rewind changes the conversation view; history stays complete.
- **The backup root is separate from the workspace.** It cannot be clobbered by project clean scripts.

## Fixed in this version

All four behaviours below existed in earlier builds. They are fixed here, and each has a regression test in
`tests/artifact-track.regression.mjs`.

### 1. An over-cap file that changed was moved out of the worktree → fixed

Content is not cached for a file above the cap (`maxFileBytes` / `artifactMaxFileBytes`). An earlier build
treated such a file as "newly created" when it had changed, so a rewind moved a file that legitimately
existed at the target state into quarantine — it looked deleted.

Now it is **skipped and left in place**, and the rewind reports "N file(s) left as-is (no content backup for
that point)". A file that genuinely did not exist at the target state is still quarantined; that is correct
and unchanged.

### 2. A same-size rewrite within 1.5 s could be missed → fixed

Change detection used `size + mtime` with a 1500 ms mtime tolerance, so a same-size rewrite right after a
boundary reused the previous digest and a rewind restored content older than the target state.

Now mtime is compared **exactly**: the previous digest is reused only when mtime is identical, otherwise the
content is hashed again.

### 3. The content cache was never reclaimed → fixed

Only manifests were pruned, so every cached copy under `artifacts/blobs/` stayed forever.

Each prune now runs a **reachability sweep**: blobs no longer referenced by any live manifest are removed,
along with `.tmp-*` files left by an interrupted write.

### 4. Dot-directories were not tracked → fixed

The walk used to skip every directory starting with `.`, so artifacts under `.output/` or `.cache/` were
invisible. Dot-directories are now tracked by default, with only VCS/tooling state skipped
(`.git`, `.hg`, `.svn`, `.dsh`, `.dsh-file-attachment`). Dependency and build directories (`node_modules`,
`dist`, `build`, `out`, …) stay excluded by default; `artifactExclude` still overrides the list.

## Remaining boundaries

- Rewinding needs existing backups. History from before the plugin was installed, or changes made while
  backups were off, has no record and cannot be restored.
- After a conversation compaction, messages earlier than the compaction point drop out of the rewind list.
- Files above the size cap are not cached, so changes that cross the cap cannot be restored (the rewind now
  says so explicitly and leaves the file alone).

## Repository layout

```
dist/     installable tarball (release asset)
lib/      host and client entry points
locale/   interface copy
scripts/  verify.mjs (integrity check), refresh.ps1 (re-sync an installed copy)
```

## License

MIT. See [LICENSE](LICENSE).
