@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-yingce-local.ps1"
if errorlevel 1 pause
