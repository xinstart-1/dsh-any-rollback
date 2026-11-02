# Changelog

## [0.19.1-rb.1] - 2026-11-02

`dsh-rollback`: a repack of upstream `dsh-rewind-plugin@0.19.1` with the artifact-tracking patch, for DSH
harness on the 0.2.1 line (0.20.0-alpha.1 requires DSH `>=0.2.2-alpha.2` and is refused at load time there).

### Added

- `lib/artifact-track.js` — turn-boundary workspace manifest (`path → size + mtime + sha256`), content
  cache keyed by digest for changed files only, and a quarantine area for files that must leave the
  worktree on a rewind (`manifests/`, `quarantine/`, `quarantine/index.json` under
  `<snapshotDir>/<sessionId>/artifacts/`).
- Five plugin config keys: `artifactTrackingEnabled`, `artifactMaxFileBytes`, `artifactBaselineContent`,
  `artifactExclude`, `artifactKeepManifests`.

### Changed

- `lib/index.js` patched (10 hunks): `ArtifactTracker` import, config schema, `turn/end` capture,
  `previewImpact` merge, `executeRewind` restore/quarantine wiring, `apply()` initialisation.
- Renamed the package to `dsh-rollback` so it can live beside the upstream package on npm. The rename is
  carried through all four identity sites the harness keys on: `package.json` `name`, the
  `cordis.patch.yml` loader row (`id` + `name`), the client bundle's `__ModuleLoader__.load({ id })`, and
  the compiled `PLUGIN_PACKAGE` / `SETTINGS_ENTRY_ID` constants.
- `package.json`: `scripts.prepare` removed so installing the tarball never attempts a build.

### Notes

- Internal identifiers keep the upstream name on purpose, so existing data stays readable: the session
  marker kind `dsh-rewind`, the snapshot directory `rewind-snapshots`, the RPC channel `/dsh-rewind`, and
  the CSS class prefix `dsh-rewind-`.
- Renaming the package drops the old settings document (the harness keys configuration by entry id).
  Re-set the backup switch and cleanup policy once on the Plugins page; stored snapshots are unaffected.
- The patch lives at the built-artifact level; upstream's source does not contain it. Installing upstream
  from the npm registry gets the unpatched plugin — reinstall this tarball, or run `scripts/refresh.ps1`
  to re-sync an existing `dsh-rollback` directory.
- Upstream documents the tracking boundary as deliberate
  (`docs/compat/tracking-boundary.md`, Limitation 1), so this is a local bypass rather than a feature
  upstream is expected to adopt.