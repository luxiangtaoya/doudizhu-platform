@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 关闭牌桌服务

echo 正在关闭牌桌服务...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0停止服务.ps1"

echo.
echo 按任意键关闭本窗口。
pause >nul
