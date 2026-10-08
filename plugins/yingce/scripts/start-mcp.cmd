@echo off
"%~dp0..\..\..\runtime\node.exe" "%~dp0start-mcp.mjs" mcp
exit /b %ERRORLEVEL%
