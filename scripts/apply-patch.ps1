<#
  apply-patch.ps1 — put the patched 0.19.1 artifact into an existing install.

  Use this when you want a plain `npm i dsh-rewind-plugin@0.19.1` copy patched in
  place (instead of installing this repository's tarball). Files are copied from
  ./package, so the result is byte-identical to the shipped tarball.

  Usage:
    .\scripts\apply-patch.ps1                                     # patch the desktop profile
    .\scripts\apply-patch.ps1 -Target <profile>\node_modules       # patch any profile
    .\scripts\apply-patch.ps1 -Target <dir> -DryRun                # report only

  Exit codes: 0 patched or already patched, 2 target not found, 3 wrong package
  version (this patch is built against 0.19.1 only).
#>
param(
  [string]$Target = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules'),
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'package\lib'
$pkgDir = Join-Path $Target 'dsh-rewind-plugin'
$manifest = Join-Path $pkgDir 'package.json'

if (-not (Test-Path $manifest)) {
  Write-Host "no dsh-rewind-plugin under $Target" -ForegroundColor Red
  exit 2
}

$version = (Get-Content $manifest -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($version -ne '0.19.1') {
  Write-Host "installed version is $version; this patch only targets 0.19.1" -ForegroundColor Red
  exit 3
}

$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
foreach ($file in @('index.js', 'artifact-track.js')) {
  $from = Join-Path $source $file
  $to = Join-Path $pkgDir (Join-Path 'lib' $file)
  $exists = Test-Path $to
  $same = $exists -and ((Get-FileHash $to -Algorithm SHA256).Hash -eq (Get-FileHash $from -Algorithm SHA256).Hash)
  if ($same) { Write-Host ("{0,-18} already patched" -f $file) -ForegroundColor DarkGray; continue }
  if ($DryRun) { Write-Host ("{0,-18} would copy (current: {1})" -f $file, $(if ($exists) { 'modified' } else { 'absent' })) -ForegroundColor Yellow; continue }
  if ($exists) { Copy-Item $to "$to.bak-$stamp" -Force }
  # remove first so a pnpm-store hard link is not overwritten in place
  if ($exists) { Remove-Item $to -Force }
  Copy-Item $from $to -Force
  Write-Host ("{0,-18} patched" -f $file) -ForegroundColor Green
}

Write-Host ''
Write-Host 'restart DSH to apply (the host half loads once per process).' -ForegroundColor Green
Write-Host "verify: node scripts/verify.mjs `"$Target\dsh-rewind-plugin`""