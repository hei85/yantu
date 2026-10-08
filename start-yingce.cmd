@echo off
if exist "%~dp0portable-manifest.json" (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-portable.ps1"
  if errorlevel 1 pause
  exit /b
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-axon.ps1"
if errorlevel 1 pause
