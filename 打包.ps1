# 打包成「免安装」目录 + zip：把 node.exe 一起带上，拷到别的电脑双击就能跑
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$name = '牌桌-斗地主'
$release = Join-Path $root 'release'
$dist = Join-Path $release $name

if (-not (Test-Path $dist)) { New-Item -ItemType Directory -Path $dist -Force | Out-Null }
Get-ChildItem $dist -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

Copy-Item (Join-Path $root 'app') -Destination $dist -Recurse
Copy-Item (Join-Path $root 'web') -Destination $dist -Recurse
foreach ($f in @('config.json', '启动.bat', '停止服务.bat', '停止服务.ps1', '允许防火墙.ps1', 'README.md')) {
  Copy-Item (Join-Path $root $f) -Destination $dist -Force
}

$node = (Get-Command node).Source
if (-not $node) { throw '找不到 node.exe，无法打包' }
Copy-Item $node (Join-Path $dist 'node.exe') -Force

$zip = Join-Path $release "$name-免安装.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $dist '*') -DestinationPath $zip -CompressionLevel Optimal -Force

$sizeMB = [math]::Round((Get-ChildItem $dist -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
$zipMB = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host ''
Write-Host "打包完成：$dist" -ForegroundColor Green
Write-Host "目录大小：$sizeMB MB    压缩包：$zipMB MB" -ForegroundColor Green
Write-Host "压缩包位置：$zip" -ForegroundColor Cyan
