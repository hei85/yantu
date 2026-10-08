[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$pointerPath = Join-Path $env:USERPROFILE '.infinite-canvas\plugin-runtime.json'
if (-not (Test-Path -LiteralPath $pointerPath)) {
    throw '衍图便携版运行时未注册，请在便携版目录运行「安装到Codex.cmd」。'
}
$pointer = Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json
$portableRoot = [IO.Path]::GetFullPath([string]$pointer.runtimeRoot)
$nodeExe = Join-Path $portableRoot 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) {
    $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
}
$launcher = Join-Path $PSScriptRoot 'start-mcp.mjs'
if (-not (Test-Path -LiteralPath $nodeExe) -or -not (Test-Path -LiteralPath $launcher)) {
    throw '衍图便携版 MCP 启动文件不完整，请重新安装插件。'
}
$env:YINGCE_RUNTIME_ROOT = $portableRoot
$env:FRAMEFIELD_LOCAL_RUNTIME_CONFIG_DIR = Join-Path $portableRoot 'canvas-agent-config'
& $nodeExe $launcher mcp
exit $LASTEXITCODE
