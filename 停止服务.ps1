# 只关掉「牌桌」自己的 node 进程，不会误伤其它 node 程序
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'app[\\/]main\.mjs' }

if (-not $procs) {
  Write-Host '没有找到正在运行的牌桌服务（可能已经关了）。' -ForegroundColor Yellow
  exit
}

foreach ($p in $procs) {
  try {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
    Write-Host "已关闭进程 $($p.ProcessId)" -ForegroundColor Green
  } catch {
    Write-Host "关闭进程 $($p.ProcessId) 失败：$($_.Exception.Message)" -ForegroundColor Red
  }
}
Write-Host '牌桌服务已停止，端口已释放。' -ForegroundColor Green
