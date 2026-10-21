@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [SkyTavern] 没有找到 Node.js，请先安装 22.18 或更新的版本：https://nodejs.org/
  pause
  exit /b 1
)

rem 参数原样传给启动脚本，例如 start.bat --no-open 或 start.bat --rebuild
node --disable-warning=ExperimentalWarning scripts\start.mjs %*
if errorlevel 1 pause
