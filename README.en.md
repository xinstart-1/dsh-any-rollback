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
| `artifactExclude` | `node_modules,.git,dist,build,out,.next,.nuxt,.cache,.turbo,coverage,__pycache__,venv,.venv,target` | subtrees skipped while tracking |
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
  "dsh-any-rollback": "https://github.com/xinstart-1/dsh-any-rollback/releases/download/v0.19.1-any.1/dsh-any-rollback-0.19.1.tgz"
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
"dsh-any-rollback": "file:C:/path/to/dsh-any-rollback/dist/dsh-any-rollback-0.19.1.tgz"
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
| `lib/index.js` | `cd386603cc41df3f3ddae1b8a34a11cb5a4033a365521ddd6adf9db39fe4f7a3` |
| `lib/artifact-track.js` | `904c08ad92e298dcb700094f37885299e968c6216c7afe1e658fe28c7bb249b5` |
| `lib/client.js` | `c1fb688c119a3823b4b421a6588eb04966fe17834ecd9b75c14e964d18cf8a85` |
| `dist/dsh-any-rollback-0.19.1.tgz` | `e1e180684389ed9ac63fb5708e60c346f4fdc3e7b8eeb5f28e56d7a6a17b37b3` |

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

## Known limits

Each of these is confirmed by test against the shipped build.

### 1. An over-cap file that changed gets moved out of the worktree

Content is not cached for a file above the cap (`maxFileBytes` / `artifactMaxFileBytes`). If such a file then
**changed**, a rewind cannot know what it held at the target state and currently treats it as a newly created
artifact — it **moves the file to quarantine**:

- nothing is lost (it sits under `quarantine/`, with its original path in `index.json`);
- but it disappears from the worktree during the rewind, which reads like a deletion;
- the intended behaviour is to skip it and say so — this needs fixing.

Workaround: add large-file directories to `artifactExclude`, or raise `artifactMaxFileBytes`.

### 2. A same-size change within 1.5 s can be missed

Change detection uses `size + mtime`, and mtime carries a 1500 ms tolerance. If a file is rewritten with
**identical size inside that window**, the plugin keeps the previous digest and a rewind restores an older
version. Scripts emitting same-size files (fixed-resolution frames, fixed-length records) hit this most.

### 3. The content cache is never reclaimed

Manifests are pruned to `artifactKeepManifests`, but **cached content is never deleted**. The longer a
session runs and the more its artifacts change, the more `artifacts/blobs/` grows; only removing the whole
session directory frees it.

### 4. Dot-directories are not tracked

The walk skips every directory starting with `.`. Artifacts written under `.output/`, `.cache/` and the like
are not handled by a rewind.

### 5. Rewinding needs existing backups

History from before the plugin was installed, or changes made while backups were off, has no record and
cannot be restored. After a conversation compaction, messages earlier than the compaction point drop out of
the rewind list.

## Repository layout

```
dist/     installable tarball (release asset)
lib/      host and client entry points
locale/   interface copy
scripts/  verify.mjs (integrity check), refresh.ps1 (re-sync an installed copy)
```

## License

MIT. See [LICENSE](LICENSE).
