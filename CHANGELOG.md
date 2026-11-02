# Changelog

## [0.19.1-artifact-patch.1] - 2026-11-02

Repack of upstream `dsh-rewind-plugin@0.19.1` with the artifact-tracking patch, for DSH harness on the
0.2.1 line (0.20.0-alpha.1 requires DSH `>=0.2.2-alpha.2` and is refused at load time there).

### Added

- `lib/artifact-track.js` — turn-boundary workspace manifest (`path → size + mtime + sha256`), content
  cache keyed by digest for changed files only, and a quarantine area for files that must leave the
  worktree on a rewind (`manifests/`, `quarantine/`, `quarantine/index.json` under
  `<snapshotDir>/<sessionId>/artifacts/`).
- Five plugin config keys: `artifactTrackingEnabled`, `artifactMaxFileBytes`, `artifactBaselineContent`,
  `artifactExclude`, `artifactKeepManifests`.

### Changed

- `lib/index.js` patched (9 hunks): `ArtifactTracker` import, config schema, `turn/end` capture,
  `previewImpact` merge, `executeRewind` restore/quarantine wiring, `apply()` initialisation.
- `package.json`: `scripts.prepare` removed so installing the tarball never attempts a build.

### Notes

- The patch lives at the built-artifact level; upstream's source does not contain it. Reinstalling from
  the npm registry loses it — reinstall from this repository's tarball or re-run
  `scripts/apply-patch.ps1`.
- Upstream documents the tracking boundary as deliberate
  (`docs/compat/tracking-boundary.md`, Limitation 1), so this is a local bypass rather than a feature
  upstream is expected to adopt.