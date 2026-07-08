@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%start-all.ps1"

if not exist "%PS1%" (
  echo [ERROR] start-all.ps1 not found at: "%PS1%"
  exit /b 1
)

pwsh -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
exit /b %ERRORLEVEL%
