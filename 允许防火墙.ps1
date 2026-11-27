# 为牌桌服务放行 Windows 防火墙入站端口（需要管理员，会自动请求提权）
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$port = 8080
try {
  $cfg = Get-Content (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($cfg.port) { $port = [int]$cfg.port }
} catch { }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host '需要管理员权限，正在提权…' -ForegroundColor Yellow
  Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  exit
}

$rule = "DoudizhuPlatform-$port"
try {
  Get-NetFirewallRule -DisplayName $rule -ErrorAction Stop | Out-Null
  Write-Host "规则已存在：$rule" -ForegroundColor Green
} catch {
  New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Any | Out-Null
  Write-Host "已放行 TCP $port 入站。" -ForegroundColor Green
}

Write-Host ''
Write-Host '完成。同事现在应该能用 http://你的IP:' -NoNewline
Write-Host $port -NoNewline -ForegroundColor Cyan
Write-Host ' 访问了。'
Read-Host '按回车键退出'
