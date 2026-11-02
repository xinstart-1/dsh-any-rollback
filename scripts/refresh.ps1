<#
  refresh.ps1 — 把已安装的 dsh-rollback 更新为本仓库的当前文件。

  DSH 用 `require.resolve('<包名>/package.json')` 定位客户端半边，所以 node_modules
  下的目录名必须等于包名。本脚本只用于刷新一个已经叫 dsh-rollback 的安装副本，
  例如手工改动过、或想从本仓库直接同步时。

  用法:
    .\scripts\refresh.ps1                                   # 默认桌面 profile
    .\scripts\refresh.ps1 -Target <profile>\node_modules     # 其它 profile
    .\scripts\refresh.ps1 -Target <dir> -DryRun              # 只报告，不改动

  退出码: 0 已刷新或本来就是最新, 2 目标不存在, 3 版本不符。
#>
param(
  [string]$Target = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules'),
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pkgDir = Join-Path $Target 'dsh-rollback'
$manifest = Join-Path $pkgDir 'package.json'

if (-not (Test-Path $manifest)) {
  Write-Host "目标下没有 dsh-rollback: $Target" -ForegroundColor Red
  Write-Host '请按 README「安装」一节用 Release tarball 或本地目录安装。' -ForegroundColor Yellow
  exit 2
}

$installed = (Get-Content $manifest -Raw -Encoding UTF8 | ConvertFrom-Json).version
$expected = (Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($installed -ne $expected) {
  Write-Host "已装版本 $installed，本仓库版本 $expected，拒绝刷新" -ForegroundColor Red
  exit 3
}

$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$changed = 0
foreach ($relative in @('lib\index.js', 'lib\client.js', 'lib\artifact-track.js', 'cordis.patch.yml', 'package.json')) {
  $from = Join-Path $root $relative
  $to = Join-Path $pkgDir $relative
  $exists = Test-Path $to
  $same = $exists -and ((Get-FileHash $to -Algorithm SHA256).Hash -eq (Get-FileHash $from -Algorithm SHA256).Hash)
  if ($same) { Write-Host ("{0,-24} 已是最新" -f $relative) -ForegroundColor DarkGray; continue }
  if ($DryRun) { Write-Host ("{0,-24} 需要更新" -f $relative) -ForegroundColor Yellow; continue }
  if ($exists) { Copy-Item $to "$to.bak-$stamp" -Force; Remove-Item $to -Force }
  Copy-Item $from $to -Force
  Write-Host ("{0,-24} 已更新" -f $relative) -ForegroundColor Green
  $changed++
}

Write-Host ''
if ($changed -eq 0) {
  Write-Host '已经是最新，无需改动' -ForegroundColor Green
} else {
  Write-Host '请重启 DSH 生效（宿主侧每个进程只加载一次）' -ForegroundColor Green
}
Write-Host "校验: node scripts/verify.mjs `"$pkgDir`""
