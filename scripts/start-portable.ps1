# SPDX-License-Identifier: LicenseRef-Yantu-Source-Available
[CmdletBinding()]
param(
    [switch]$NoBrowser,
    [switch]$SkipOfficialGuides,
    [ValidateRange(1024,65535)][int]$WebPort = 3000,
    [ValidateRange(1024,65535)][int]$BackendPort = 8080,
    [ValidateRange(1024,65535)][int]$RuntimePort = 17371
)
$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitOperatingSystem) { throw 'This package requires Windows 10/11 x64.' }
if (@($WebPort,$BackendPort,$RuntimePort | Select-Object -Unique).Count -ne 3) { throw 'The three service ports must be different.' }
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$nodeExe = Join-Path $projectRoot 'runtime\node.exe'
$pythonExe = Join-Path $projectRoot 'python-runtime\python.exe'
$backendDir = Join-Path $projectRoot 'backend'
$backendExe = Join-Path $backendDir 'server.exe'
$agentDir = Join-Path $projectRoot 'canvas-agent'
$stateDir = Join-Path $projectRoot '.local\runtime'
$dataDir = Join-Path $projectRoot '.local\app-data'
$configDir = Join-Path $projectRoot 'canvas-agent-config'
$webUrl = "http://localhost:$WebPort"
$backendUrl = "http://127.0.0.1:$BackendPort"
$runtimeUrl = "http://127.0.0.1:$RuntimePort"
$pidFile = Join-Path $stateDir 'pids.json'
foreach ($file in @($nodeExe,$pythonExe,$backendExe,(Join-Path $projectRoot 'web\dist\index.html'),(Join-Path $agentDir 'dist\index.js'),(Join-Path $projectRoot 'runtime\ffmpeg\bin\ffmpeg.exe'),(Join-Path $projectRoot 'portable-manifest.json'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Portable package is incomplete: $file. Extract the entire ZIP before starting." }
}
# Native ONNX and Torch wheels need Microsoft's C++ runtime on fresh Windows.
# Show the original Microsoft installer only when that prerequisite is missing.
$systemDllDir = Join-Path $env:SystemRoot 'System32'
if (-not (Test-Path -LiteralPath (Join-Path $systemDllDir 'msvcp140.dll')) -or -not (Test-Path -LiteralPath (Join-Path $systemDllDir 'vcruntime140_threads.dll'))) {
    $redist = Join-Path $projectRoot 'runtime\vc-redist\vc_redist.x64.exe'
    if (-not (Test-Path -LiteralPath $redist)) { throw 'Microsoft Visual C++ runtime is missing. Run the official installer: https://aka.ms/vs/17/release/vc_redist.x64.exe' }
    Write-Host 'First use on this Windows installation: complete the Microsoft Visual C++ Runtime installer. No developer tools are required.'
    $installedRuntime = Start-Process -FilePath $redist -ArgumentList '/install /norestart' -Verb RunAs -Wait -PassThru
    if ($installedRuntime.ExitCode -notin @(0,1638,3010)) { throw "Microsoft runtime installation did not complete (exit $($installedRuntime.ExitCode))." }
}

function Test-HttpReady([string]$Url) {
    try { return (Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 }
    catch { return $false }
}
function Test-OwnedProcess([int]$ProcessId) {
    if ($ProcessId -le 0) { return $false }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if (-not $process) { return $false }
    return ([string]$process.CommandLine).IndexOf($projectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or ([string]$process.ExecutablePath).StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)
}
if (Test-Path -LiteralPath $pidFile) {
    try {
        $saved = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
        $ownsAll = (Test-OwnedProcess ([int]$saved.backend)) -and (Test-OwnedProcess ([int]$saved.agent)) -and (Test-OwnedProcess ([int]$saved.web))
        if ($ownsAll -and (Test-HttpReady "$backendUrl/api/health") -and (Test-HttpReady "$runtimeUrl/health") -and (Test-HttpReady "$webUrl/")) {
            Write-Host "Yantu is already running: $webUrl"
            if (-not $NoBrowser) { Start-Process $webUrl | Out-Null }
            exit 0
        }
    } catch { Write-Warning 'Previous startup state could not be reused.' }
}
foreach ($port in @($WebPort,$BackendPort,$RuntimePort)) {
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { throw "Port $port is in use. Stop the old instance with its stop command, or choose another port. No other application was stopped." }
}
New-Item -ItemType Directory -Force -Path $stateDir,$dataDir,$configDir | Out-Null
$stdinPath = Join-Path $stateDir 'stdin.txt'
if (-not (Test-Path -LiteralPath $stdinPath)) { New-Item -ItemType File -Path $stdinPath | Out-Null }
# Always prefer the shipped tools. No package manager or system Python is used.
$env:PATH = (Join-Path $projectRoot 'runtime') + ';' + (Join-Path $projectRoot 'runtime\ffmpeg\bin') + ';' + (Join-Path $projectRoot 'python-runtime') + ';' + $env:PATH
$env:CANVAS_FFMPEG_PATH = Join-Path $projectRoot 'runtime\ffmpeg\bin\ffmpeg.exe'
$env:CANVAS_FFPROBE_PATH = Join-Path $projectRoot 'runtime\ffmpeg\bin\ffprobe.exe'
$env:CANVAS_BACKEND_ADDR = "127.0.0.1:$BackendPort"
$env:CANVAS_BACKEND_DATA_DIR = $dataDir
$env:CANVAS_DATABASE_DRIVER = 'sqlite'
$env:DATABASE_URL = ''
$env:REDIS_URL = ''
$env:CANVAS_CORS_ORIGINS = "$webUrl,http://127.0.0.1:$WebPort"
$env:CANVAS_SELF_USE_MODE = '1'
$env:CANVAS_PORTABLE_NO_LOGIN = '1'
$env:CANVAS_INLINE_MEDIA_URLS = '1'
$env:CANVAS_AUTO_MIGRATE = 'true'
$env:CANVAS_PROJECT_ROOT = $projectRoot
$env:YINGCE_RUNTIME_ROOT = $projectRoot
$env:ENABLE_PROVIDER_PLUGINS = 'false'
$env:FRAMEFIELD_LOCAL_RUNTIME_CONFIG_DIR = $configDir
$env:FRAMEFIELD_PORTABLE_BACKEND_API_URL = "$backendUrl/api"
$env:FRAMEFIELD_TRUSTED_WEB_ORIGINS = "$webUrl,http://127.0.0.1:$WebPort"
$env:CANVAS_DEPTH_PYTHON = $pythonExe
$env:CANVAS_LINEART_PYTHON = $pythonExe
$env:CANVAS_POSE_PYTHON = $pythonExe
$env:CANVAS_CUTOUT_PYTHON = $pythonExe
$env:PYTHONHOME = Join-Path $projectRoot 'python-runtime'
$env:PYTHONPATH = ''
$env:PYTHONNOUSERSITE = '1'
$env:HF_HOME = Join-Path $projectRoot 'models\huggingface'
$env:HF_HUB_CACHE = Join-Path $env:HF_HOME 'hub'
$env:CANVAS_DEPTH_HF_HOME = $env:HF_HOME
$env:CANVAS_LINEART_HF_HOME = $env:HF_HOME
$env:CANVAS_POSE_HF_HOME = $env:HF_HOME
$env:CANVAS_CUTOUT_MODEL_HOME = Join-Path $projectRoot 'models\rembg'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
$env:OMP_NUM_THREADS = '4'
$env:PORTABLE_API_TARGET = $backendUrl
$env:PORTABLE_WEB_PORT = [string]$WebPort
$env:PORT = [string]$RuntimePort
$env:GIN_MODE = 'release'
$processes = @{}
try {
    $processes.backend = (Start-Process -FilePath $backendExe -WorkingDirectory $backendDir -WindowStyle Hidden -PassThru -RedirectStandardInput $stdinPath -RedirectStandardOutput (Join-Path $stateDir 'backend.log') -RedirectStandardError (Join-Path $stateDir 'backend.err.log')).Id
    $processes.agent = (Start-Process -FilePath $nodeExe -ArgumentList ('"' + (Join-Path $agentDir 'dist\index.js') + '"') -WorkingDirectory $agentDir -WindowStyle Hidden -PassThru -RedirectStandardInput $stdinPath -RedirectStandardOutput (Join-Path $stateDir 'agent.log') -RedirectStandardError (Join-Path $stateDir 'agent.err.log')).Id
    $processes.web = (Start-Process -FilePath $nodeExe -ArgumentList ('"' + (Join-Path $PSScriptRoot 'serve-web.mjs') + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardInput $stdinPath -RedirectStandardOutput (Join-Path $stateDir 'web.log') -RedirectStandardError (Join-Path $stateDir 'web.err.log')).Id
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    $ready = $false
    do {
        foreach ($processId in $processes.Values) { if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { throw 'A service exited. See .local/runtime/*.err.log.' } }
        $ready = (Test-HttpReady "$backendUrl/api/health") -and (Test-HttpReady "$runtimeUrl/health") -and (Test-HttpReady "$webUrl/")
        if (-not $ready) { Start-Sleep -Milliseconds 400 }
    } while (-not $ready -and [DateTime]::UtcNow -lt $deadline)
    if (-not $ready) { throw 'Startup timed out. See .local/runtime/*.err.log.' }
    $processes | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
} catch {
    foreach ($processId in $processes.Values) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }
    throw
}
# Official guides retain their upstream rights and are fetched in the background.
if (-not $SkipOfficialGuides) {
    $guideInstaller = Join-Path $PSScriptRoot 'install-official-h3-guides.ps1'
    $psExe = Join-Path $PSHOME 'powershell.exe'
    if (-not (Test-Path -LiteralPath $psExe)) { $psExe = Join-Path $PSHOME 'pwsh.exe' }
    Start-Process -FilePath $psExe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $guideInstaller + '"') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stateDir 'h3-guides.log') -RedirectStandardError (Join-Path $stateDir 'h3-guides.err.log') | Out-Null
}
Write-Host "Yantu Axon portable edition is ready: $webUrl"
Write-Host 'First use: Settings > Model center > enter your own Axon API Key and import models.'
if (-not $NoBrowser) { Start-Process $webUrl | Out-Null }
