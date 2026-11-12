@echo off
title MESSEZE MEDI - selftest
cd /d "%~dp0"
chcp 65001 >nul
node selftest.js
echo.
pause
