@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Doudizhu Platform

if exist "%~dp0node.exe" (
  set "NODE=%~dp0node.exe"
) else (
  set "NODE=node"
)

"%NODE%" --version >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [ERROR] Node runtime not found.
  echo  Please keep node.exe in the same folder as this file.
  echo.
  pause
  exit /b 1
)

rem Try to open the browser after the server starts.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8080'"

rem Silent attempt to allow inbound traffic (needs admin; ignore failures).
netsh advfirewall firewall show rule name="DoudizhuPlatform" >nul 2>nul
if errorlevel 1 netsh advfirewall firewall add rule name="DoudizhuPlatform" dir=in action=allow protocol=TCP localport=8080 >nul 2>nul

"%NODE%" app\main.mjs

echo.
echo  Server stopped. Press any key to close.
pause >nul
