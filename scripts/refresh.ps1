<#
  refresh.ps1 — bring an installed dsh-rollback copy up to this repository's files.

  After the rename, an in-place patch of an upstream `dsh-rewind-plugin`
  directory is NOT possible: the harness resolves the client half with
  `require.resolve('<package-name>/package.json')`, so the directory name under
  node_modules must equal the name in the manifest. The supported install paths
  are the release tarball or a clone (see README) — this script only refreshes a
  copy that is already `dsh-rollback`, e.g. after re-downloading or hand-editing.

  Usage:
    .\scripts\refresh.ps1                                  # the desktop profile
    .\scripts\refresh.ps1 -Target <profile>\node_modules    # another profile
    .\scripts\refresh.ps1 -Target <dir> -DryRun             # report only

  Exit codes: 0 refreshed or already current, 2 not found, 3 unexpected version.
#>
param(
  [string]$Target = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules'),
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'package'
$pkgDir = Join-Path $Target 'dsh-rollback'
$manifest = Join-Path $pkgDir 'package.json'

if (-not (Test-Path $manifest)) {
  $upstream = Join-Path $Target 'dsh-rewind-plugin'
  if (Test-Path (Join-Path $upstream 'package.json')) {
    Write-Host "found the upstream 'dsh-rewind-plugin' directory, not 'dsh-rollback'." -ForegroundColor Yellow
    Write-Host 'An in-place patch cannot work: the directory name must equal the package name.' -ForegroundColor Yellow
    Write-Host 'Install this package from the tarball or a clone instead — see README "Install".' -ForegroundColor Yellow
  } else {
    Write-Host "no dsh-rollback under $Target" -ForegroundColor Red
  }
  exit 2
}

$installed = (Get-Content $manifest -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($installed -ne '0.19.1') {
  Write-Host "installed version is $installed; this package ships 0.19.1" -ForegroundColor Red
  exit 3
}

$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$changed = 0
foreach ($relative in @('lib\index.js', 'lib\client.js', 'lib\artifact-track.js', 'cordis.patch.yml', 'package.json')) {
  $from = Join-Path $source $relative
  $to = Join-Path $pkgDir $relative
  $exists = Test-Path $to
  $same = $exists -and ((Get-FileHash $to -Algorithm SHA256).Hash -eq (Get-FileHash $from -Algorithm SHA256).Hash)
  if ($same) { Write-Host ("{0,-24} current" -f $relative) -ForegroundColor DarkGray; continue }
  if ($DryRun) { Write-Host ("{0,-24} would update" -f $relative) -ForegroundColor Yellow; continue }
  if ($exists) { Copy-Item $to "$to.bak-$stamp" -Force; Remove-Item $to -Force }
  Copy-Item $from $to -Force
  Write-Host ("{0,-24} updated" -f $relative) -ForegroundColor Green
  $changed++
}

Write-Host ''
if ($changed -eq 0) {
  Write-Host 'already up to date' -ForegroundColor Green
} else {
  Write-Host 'restart DSH to apply (the host half loads once per process).' -ForegroundColor Green
}
Write-Host "verify: node scripts/verify.mjs `"$pkgDir`""