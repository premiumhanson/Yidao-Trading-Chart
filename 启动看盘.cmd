@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js 24.15 or later is required.
  pause
  exit /b 1
)
set "browser_flag=--open"
if /i "%~1"=="--no-open" set "browser_flag="
node.exe --env-file-if-exists=.env.local --disable-warning=ExperimentalWarning server.mjs %browser_flag%
if errorlevel 1 pause
