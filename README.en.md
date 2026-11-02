# dsh-rollback

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

`dsh-rollback` does both: click ↶ on a message and the conversation returns to just before it, with the
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
  "dsh-rollback": "https://github.com/xinstart-1/dsh-rollback/releases/download/v0.19.1-rb.2/dsh-rollback-0.19.1.tgz"
}
```

Install and restart DSH:

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
& $node $pnpm install --dir "$env:USERPROFILE\.dsh\profiles\<profile>" --prefer-offline
```

Also make sure `dsh-rollback` is listed in that profile's `dsh.profile.bundles` array — that array is what
actually loads the plugin.

### From a local clone

```json
"dsh-rollback": "file:C:/path/to/dsh-rollback/dist/dsh-rollback-0.19.1.tgz"
```

## Requirements

| Item | Requirement |
| --- | --- |
| DSH | `>=0.2.1-rc.1 <0.3.0-0` |
| Node.js | `^22.19.0` or `>=24.0.0` |

## Verify the install

```powershell
node scripts\verify.mjs                                            # current desktop profile
node scripts\verify.mjs "C:\path\to\node_modules\dsh-rollback"      # any unpacked dir
```

Expected digests (SHA-256):

| File | SHA-256 |
| --- | --- |
| `lib/index.js` | `cd386603cc41df3f3ddae1b8a34a11cb5a4033a365521ddd6adf9db39fe4f7a3` |
| `lib/artifact-track.js` | `e3d909c91f25ee144d668b2841278d14fd9dfab4d625596d7fe808622a29f1e6` |
| `lib/client.js` | `5d29b0fa28577bcf8d2c0425029016f18a63efcdfbe138ac0b6d07f21c766461` |
| `dist/dsh-rollback-0.19.1.tgz` | `7a18df38e9323aec964e49b5720a08933ddb921ba12939fec64e9b13b00bb28f` |

**Restart DSH** after installing (the host half loads once per process). Then run one turn and confirm a
manifest appeared under `~/.dsh/rewind-snapshots/<sessionId>/artifacts/manifests/` and the ↶ buttons show up.

## Uninstall

Remove `dsh-rollback` from the profile's `dependencies` and `dsh.profile.bundles`, then reinstall. Backup
data is not deleted automatically — remove `~/.dsh/rewind-snapshots/` to wipe it.

## Design decisions

- **Only write back what was backed up.** Prefer restoring less over overwriting with a guess.
- **Never delete a file.** Anything that must leave the worktree goes to quarantine.
- **The session log is append-only.** A rewind changes the conversation view; history stays complete.
- **The backup root is separate from the workspace.** It cannot be clobbered by project clean scripts.

## Known limits

- Rewinding needs existing backups. History from before the plugin was installed, or changes made while
  backups were off, has no record and cannot be restored.
- A file above the backup cap gets no new backup; a rewind skips it and says so.
- After a conversation compaction, messages earlier than the compaction point drop out of the rewind list.

## Repository layout

```
dist/     installable tarball (release asset)
package/  the same package unpacked, for review
lib/      host and client entry points (build output)
scripts/  verify.mjs (integrity check), refresh.ps1 (re-sync an installed copy)
```

## License

MIT. See [LICENSE](LICENSE).
