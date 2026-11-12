@echo off
title MESSEZE MEDI - update
cd /d "%~dp0"
chcp 65001 >nul
node updater.js apply
echo.
echo If the dashboard is running, close its window and start RUN_dashboard.bat again.
pause
