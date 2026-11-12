@echo off
title MESSEZE MEDI Dashboard (5015)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] Node.js is not installed. Install the LTS version from https://nodejs.org and run again.
  echo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing packages - npm install ...
  call npm install --no-audit --no-fund
)
chcp 65001 >nul
echo Checking for updates ...
node updater.js apply
start "" http://127.0.0.1:5015

:restart
echo.
echo ================================================
echo  Dashboard running - http://127.0.0.1:5015
echo  (Closing this window stops the program)
echo ================================================
echo.
node writer.js
set CODE=%errorlevel%
echo.
echo [%date% %time%] Program exited (code %CODE%).
if "%CODE%"=="42" (
  echo Updated - starting the new version ...
  goto restart
)
if "%CODE%"=="1" (
  echo Cannot start - check the message above. Is port 5015 already in use?
  pause
  exit /b 1
)
echo Restarting in 5 seconds... Close this window to stop completely.
timeout /t 5 /nobreak >nul
goto restart
