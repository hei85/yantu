[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$agentEntry = Join-Path $root "canvas-agent\dist\index.js"
$mcpLauncher = Join-Path $root "plugins\yingce\scripts\start-mcp.mjs"
$configDir = Join-Path $root "canvas-agent-config"
$nodeExe = Join-Path $root "runtime\node.exe"
if (-not (Test-Path -LiteralPath $nodeExe)) {
    $nodeCommand = Get-Command node.exe -ErrorAction Stop
    $nodeExe = $nodeCommand.Source
}
$pluginDir = Join-Path $root "plugins\yingce"
$marketplaceFile = Join-Path $root ".agents\plugins\marketplace.json"

foreach ($required in @($agentEntry, $mcpLauncher, $nodeExe, $pluginDir, $marketplaceFile)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "便携包不完整，缺少：$required" }
}

$codex = Get-Command codex -ErrorAction SilentlyContinue
if (-not $codex) {
    Write-Host "没有检测到 codex 命令。" -ForegroundColor Yellow
    Write-Host "请先安装 Codex（桌面版或 CLI），安装后重新打开终端，再运行本脚本。"
    exit 1
}

New-Item -ItemType Directory -Force -Path $configDir | Out-Null
$pointerDir = Join-Path $env:USERPROFILE ".infinite-canvas"
New-Item -ItemType Directory -Force -Path $pointerDir | Out-Null
[IO.File]::WriteAllText(
    (Join-Path $pointerDir "plugin-runtime.json"),
    (@{ runtimeRoot = $root; configDir = $configDir } | ConvertTo-Json),
    [Text.UTF8Encoding]::new($false)
)
Write-Host "已写入运行时指针：$pointerDir\plugin-runtime.json" -ForegroundColor Cyan

# A running Codex chat may still hold the previous cached plugin directory open.
# Stop only MCP children launched by this exact portable package before replacing
# that cache; leave the web, backend, Canvas Agent and other Node processes alone.
$portableMcpProcesses = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -like "*$mcpLauncher mcp*"
})
foreach ($process in $portableMcpProcesses) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
}
if ($portableMcpProcesses.Count -gt 0) {
    Write-Host "已结束 $($portableMcpProcesses.Count) 个本便携版旧 MCP 连接；更新后请打开新的 Codex 对话。" -ForegroundColor Cyan
}

codex plugin marketplace remove yingce-local 2>$null | Out-Null
codex plugin marketplace add $root | Out-Null

codex plugin remove yingce@yingce-local --json 2>$null | Out-Null
codex plugin add yingce@yingce-local --json | Out-Null

codex mcp remove yingce 2>$null | Out-Null
$pluginList = (codex plugin list --json | ConvertFrom-Json).installed
$installed = $pluginList | Where-Object { $_.pluginId -eq 'yingce@yingce-local' } | Select-Object -First 1
if ($LASTEXITCODE -ne 0 -or -not $installed -or -not $installed.enabled -or
    [IO.Path]::GetFullPath([string]$installed.source.path) -ne [IO.Path]::GetFullPath($pluginDir)) {
    throw '衍图插件安装校验失败：Codex 未指向本便携版目录。'
}

# Use the portable Node process directly in Codex. A PowerShell wrapper can
# leave its Node child running after the MCP client disconnects.
$codexHomeDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$installedPluginDir = Join-Path $codexHomeDir "plugins\cache\yingce-local\yingce\$([string]$installed.version)"
$installedMcpFile = Join-Path $installedPluginDir '.mcp.json'
if (-not (Test-Path -LiteralPath $installedMcpFile)) { throw "插件 MCP 配置缺失：$installedMcpFile" }
$mcpConfig = Get-Content -LiteralPath $installedMcpFile -Raw | ConvertFrom-Json
$mcpConfig.mcpServers.yingce.command = $nodeExe
$mcpConfig.mcpServers.yingce.args = @($mcpLauncher, 'mcp')
$mcpConfig.mcpServers.yingce.cwd = $installedPluginDir
[IO.File]::WriteAllText($installedMcpFile, ($mcpConfig | ConvertTo-Json -Depth 16), [Text.UTF8Encoding]::new($false))

Write-Host ""
Write-Host "安装完成：Codex 衍图插件及其 MCP 服务已指向本便携包" -ForegroundColor Green
Write-Host "  MCP 启动器：$mcpLauncher"
Write-Host "  运行入口：$agentEntry"
Write-Host "  配置目录：$configDir"
Write-Host ""
Write-Host "使用顺序：先运行 启动衍图.cmd 把本地服务拉起来，再在 Codex 里调用衍图工具。"
