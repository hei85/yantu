@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-yingce-local.ps1"
if errorlevel 1 pause
