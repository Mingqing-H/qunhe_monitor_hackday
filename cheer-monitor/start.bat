@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动 Hackday 点赞监控...
node server.js
pause
