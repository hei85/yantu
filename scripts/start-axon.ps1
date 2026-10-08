# SPDX-License-Identifier: LicenseRef-Yantu-Source-Available
[CmdletBinding()]
param([switch]$Rebuild, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$stateDir = Join-Path $projectRoot '.local\runtime'
$dataDir = Join-Path $projectRoot '.local\app-data'
$agentConfigDir = Join-Path $projectRoot 'canvas-agent-config'
$backendDir = Join-Path $projectRoot 'backend'
$webDir = Join-Path $projectRoot 'web'
$agentDir = Join-Path $projectRoot 'canvas-agent'
$backendExe = Join-Path $backendDir 'server.exe'
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$bunExe = (Get-Command bun.exe -ErrorAction Stop).Source
if ([version]((& $nodeExe --version).TrimStart('v')) -lt [version]'22.13.0') { throw '需要 Node.js 22.13 或更新版本。' }
foreach ($port in 3000,8080,17371) {
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { throw "端口 $port 正在使用。请先关闭本软件的旧实例；此脚本不会终止其他软件。" }
}
New-Item -ItemType Directory -Force -Path $stateDir,$dataDir,$agentConfigDir | Out-Null
$stdinPath = Join-Path $stateDir 'stdin.txt'
if (-not (Test-Path -LiteralPath $stdinPath)) { New-Item -ItemType File -Path $stdinPath | Out-Null }

function Invoke-Bun([string]$Directory, [string[]]$Arguments) {
    Push-Location $Directory
    try { & $bunExe @Arguments; if ($LASTEXITCODE -ne 0) { throw "Bun 命令失败：$($Arguments -join ' ')" } }
    finally { Pop-Location }
}
foreach ($directory in @($webDir,$agentDir)) {
    if (-not (Test-Path -LiteralPath (Join-Path $directory 'node_modules'))) { Invoke-Bun $directory @('install','--frozen-lockfile') }
}
if ($Rebuild -or -not (Test-Path -LiteralPath $backendExe)) {
    $goExe = (Get-Command go.exe -ErrorAction Stop).Source
    if (-not (Get-Command gcc.exe -ErrorAction SilentlyContinue)) { throw 'Go SQLite 编译需要 GCC。请安装 MinGW-w64，并将其 bin 加入 PATH。' }
    Push-Location $backendDir
    try {
        $releaseVersion = ([IO.File]::ReadAllText((Join-Path $projectRoot 'VERSION'))).Trim()
        $buildFlags = '-X infinite-canvas/backend/internal/buildinfo.Version=' + $releaseVersion
        & $goExe build -trimpath -ldflags $buildFlags -o $backendExe ./cmd/server
        if ($LASTEXITCODE -ne 0) { throw '后端编译失败' }
    }
    finally { Pop-Location }
}
if ($Rebuild -or -not (Test-Path -LiteralPath (Join-Path $webDir 'dist\index.html'))) { Invoke-Bun $webDir @('run','build') }
if ($Rebuild -or -not (Test-Path -LiteralPath (Join-Path $agentDir 'dist\index.js'))) { Invoke-Bun $agentDir @('run','build') }
try { & (Join-Path $PSScriptRoot 'install-official-h3-guides.ps1') }
catch { Write-Warning '官方 H3 指南未下载完成。H3 使用前请运行 scripts/install-official-h3-guides.ps1；其他功能可继续使用。' }

$env:CANVAS_BACKEND_ADDR = '127.0.0.1:8080'
$env:CANVAS_BACKEND_DATA_DIR = $dataDir
$env:CANVAS_DATABASE_DRIVER = 'sqlite'
$env:DATABASE_URL = ''
$env:REDIS_URL = ''
$env:CANVAS_CORS_ORIGINS = 'http://localhost:3000,http://127.0.0.1:3000'
$env:CANVAS_SELF_USE_MODE = '1'
$env:CANVAS_PORTABLE_NO_LOGIN = '1'
$env:CANVAS_INLINE_MEDIA_URLS = '1'
$env:CANVAS_AUTO_MIGRATE = 'true'
$env:CANVAS_PROJECT_ROOT = $projectRoot
$env:ENABLE_PROVIDER_PLUGINS = 'false'
$env:FRAMEFIELD_LOCAL_RUNTIME_CONFIG_DIR = $agentConfigDir
$env:FRAMEFIELD_PORTABLE_BACKEND_API_URL = 'http://127.0.0.1:8080/api'
$env:FRAMEFIELD_TRUSTED_WEB_ORIGINS = 'http://localhost:3000,http://127.0.0.1:3000'
$pythonExe = Join-Path $projectRoot '.local\image-analysis\Scripts\python.exe'
if (Test-Path -LiteralPath $pythonExe) {
    $env:CANVAS_DEPTH_PYTHON = $pythonExe
    $env:CANVAS_POSE_PYTHON = $pythonExe
    $env:CANVAS_CUTOUT_PYTHON = $pythonExe
}
$env:HF_HOME = Join-Path $projectRoot '.local\cache\huggingface'
$env:CANVAS_DEPTH_HF_HOME = $env:HF_HOME
$env:CANVAS_LINEART_HF_HOME = $env:HF_HOME
$env:CANVAS_POSE_HF_HOME = $env:HF_HOME
$env:CANVAS_CUTOUT_MODEL_HOME = Join-Path $projectRoot '.local\cache\rembg'
$env:PORTABLE_API_TARGET = 'http://127.0.0.1:8080'
$env:PORTABLE_WEB_PORT = '3000'
$env:PORT = '17371'
$processes = @{}
try {
    $processes.backend = (Start-Process -FilePath $backendExe -WorkingDirectory $backendDir -WindowStyle Hidden -PassThru -RedirectStandardInput $stdinPath -RedirectStandardOutput (Join-Path $stateDir 'backend.log') -RedirectStandardError (Join-Path $stateDir 'backend.err.log')).Id
    $agentEntry = '"' + (Join-Path $agentDir 'dist\index.js') + '"'
    $processes.agent = (Start-Process -FilePath $nodeExe -ArgumentList $agentEntry -WorkingDirectory $agentDir -WindowStyle Hidden -PassThru -RedirectStandardInput $stdinPath -RedirectStandardOutput (Join-Path $stateDir 'agent.log') -RedirectStandardError (Join-Path $stateDir 'agent.err.log')).Id
    $webEntry = '"' + (Join-Path $PSScriptRoot 'serve-web.mjs') + '"'
    $processes.web = (Start-Process -FilePath $nodeExe -ArgumentList $webEntry -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardInput $stdinPath -RedirectStandardOutput (Join-Path $stateDir 'web.log') -RedirectStandardError (Join-Path $stateDir 'web.err.log')).Id
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    $ready = $false
    do {
        foreach ($processId in $processes.Values) { if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { throw '软件启动进程已退出，请查看 .local/runtime 中的日志。' } }
        try {
            $backendResponse = Invoke-WebRequest -Uri 'http://127.0.0.1:8080/api/health' -UseBasicParsing -TimeoutSec 2
            $webResponse = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/' -UseBasicParsing -TimeoutSec 2
            $agentListener = Get-NetTCPConnection -LocalPort 17371 -State Listen -ErrorAction SilentlyContinue
            $ready = $backendResponse.StatusCode -eq 200 -and $webResponse.StatusCode -eq 200 -and $null -ne $agentListener
        } catch { $ready = $false }
        if (-not $ready) { Start-Sleep -Milliseconds 400 }
    } while (-not $ready -and [DateTime]::UtcNow -lt $deadline)
    if (-not $ready) { throw '启动等待超时，请查看 .local/runtime 中的日志；没有终止其他软件。' }
    $processes | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateDir 'pids.json') -Encoding UTF8
} catch {
    foreach ($processId in $processes.Values) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }
    throw
}
Write-Host '衍图 Axon 版已启动：http://localhost:3000；首次使用请到模型中心填写你自己的 Axon API Key。'
if (-not $NoBrowser) { Start-Process 'http://localhost:3000' | Out-Null }
