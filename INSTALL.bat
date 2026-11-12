@echo off
title MESSEZE MEDI - install
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] Node.js is not installed. Install the LTS version from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)
echo Installing packages - npm install ...
call npm install --no-audit --no-fund
chcp 65001 >nul
echo.
node selftest.js
echo.
pause
