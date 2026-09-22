[CmdletBinding()]
param(
    [switch]$Rebuild
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "windows-proxy.ps1")
Import-CanvasWindowsProxy

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$backendDir = Join-Path $repoRoot "backend"
$webDir = Join-Path $repoRoot "web"
$agentDir = Join-Path $repoRoot "canvas-agent"
$localDir = Join-Path $repoRoot ".local"
$dataDir = Join-Path $localDir "project-workbench-debug"
$runtimeDir = Join-Path $localDir "runtime"

# 服务进程用文件当 stdin，避免继承调用方控制台句柄：一键启动的窗口可以立即退出，不被后台服务挂住。
$serviceStdin = Join-Path $runtimeDir "service-stdin.txt"
if (-not (Test-Path -LiteralPath $serviceStdin)) {
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    New-Item -ItemType File -Path $serviceStdin -Force | Out-Null
}
$agentConfigDir = Join-Path $localDir "canvas-agent"
$goBuildCache = Join-Path $localDir "cache\go-build"
$goModuleCache = Join-Path $localDir "cache\go-mod"
$backendExe = Join-Path $backendDir "server.exe"
$agentEntry = Join-Path $agentDir "dist\index.js"
$pidFile = Join-Path $runtimeDir "pids.json"

New-Item -ItemType Directory -Force -Path $dataDir, $runtimeDir, $agentConfigDir, $goBuildCache, $goModuleCache | Out-Null

function Resolve-CommandPath([string[]]$Names, [string[]]$Fallbacks = @()) {
    foreach ($name in $Names) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command) { return $command.Source }
    }
    foreach ($path in $Fallbacks) {
        if (Test-Path -LiteralPath $path) { return $path }
    }
    throw "Required command not found: $($Names -join ', ')"
}

$mingwRoot = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages") -Directory -Filter "BrechtSanders.WinLibs.POSIX.UCRT_*" -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName "mingw64\bin" } |
    Where-Object { Test-Path -LiteralPath (Join-Path $_ "gcc.exe") } |
    Select-Object -First 1
if ($mingwRoot) { $env:Path = "$mingwRoot;$env:Path" }

$bunFallback = Join-Path $env:APPDATA "npm\node_modules\bun\bin\bun.exe"
if (Test-Path -LiteralPath $bunFallback) {
    $bunExe = $bunFallback
} else {
    try {
        $bunExe = Resolve-CommandPath @("bun.exe")
    } catch {
        # 首次使用且未安装 bun 时，自动通过 npm 安装（需要已安装 Node.js）。
        $npmExe = Resolve-CommandPath @("npm.cmd", "npm") @((Join-Path $env:ProgramFiles "nodejs\npm.cmd"))
        Write-Host "未检测到 bun，正在通过 npm 自动安装..." -ForegroundColor Yellow
        & $npmExe install -g bun
        $bunExe = Resolve-CommandPath @("bun.exe") @($bunFallback)
    }
}
$nodeExe = Resolve-CommandPath @("node") @((Join-Path $env:ProgramFiles "nodejs\node.exe"))
# Go 仅在需要重新编译后端时才必需：内置 server.exe 的免构建包不需要安装 Go。
$script:goExe = $null
function Get-GoExe() {
    if ($script:goExe) { return $script:goExe }
    $script:goExe = Resolve-CommandPath @("go") @((Join-Path $env:ProgramFiles "Go\bin\go.exe"))
    return $script:goExe
}

if (-not (Test-Path -LiteralPath (Join-Path $webDir "node_modules\.bin\vite.exe"))) {
    Write-Host "Installing frontend dependencies with Bun..." -ForegroundColor Yellow
    Push-Location $webDir
    try { & $bunExe install --frozen-lockfile --no-progress } finally { Pop-Location }
}

if ($Rebuild -or -not (Test-Path -LiteralPath $backendExe)) {
    Write-Host "Building local backend..." -ForegroundColor Yellow
    Push-Location $backendDir
    try {
        $env:GOCACHE = $goBuildCache
        $env:GOMODCACHE = $goModuleCache
        & (Get-GoExe) build -o $backendExe ./cmd/server
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $agentDir "node_modules\express\package.json"))) {
    Write-Host "Installing Canvas Agent dependencies with Bun..." -ForegroundColor Yellow
    Push-Location $agentDir
    try { & $bunExe install --frozen-lockfile --no-progress } finally { Pop-Location }
}
if ($Rebuild -or -not (Test-Path -LiteralPath $agentEntry)) {
    Write-Host "Building Canvas Agent..." -ForegroundColor Yellow
    Push-Location $agentDir
    try { & $bunExe run build } finally { Pop-Location }
}

function Test-ListeningPort([int]$Port) {
    try {
        return $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1)
    } catch {
        return $false
    }
}

function Assert-PortAvailable([int]$Port) {
    if (Test-ListeningPort $Port) {
        throw "Port $Port is already in use. Run scripts\stop-yingce-local.ps1 or close the existing service first."
    }
}

if (Test-Path -LiteralPath $pidFile) {
    try {
        $running = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
        $alive = @($running.backend, $running.web, $running.agent) | ForEach-Object { Get-Process -Id ([int]$_) -ErrorAction SilentlyContinue }
        if ($alive.Count -eq 3 -and (Test-ListeningPort 8080) -and (Test-ListeningPort 3000) -and (Test-ListeningPort 17371)) {
            Write-Host "Yingce local workstation is already running." -ForegroundColor Green
            Write-Host "Web: http://localhost:3000"
            Start-Process "http://localhost:3000" | Out-Null
            exit 0
        }
    } catch {
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    }
}

Assert-PortAvailable 8080
Assert-PortAvailable 3000
Assert-PortAvailable 17371

$backendOut = Join-Path $runtimeDir "backend.out.log"
$backendErr = Join-Path $runtimeDir "backend.err.log"
$webOut = Join-Path $runtimeDir "web.out.log"
$webErr = Join-Path $runtimeDir "web.err.log"
$agentOut = Join-Path $runtimeDir "canvas-agent.out.log"
$agentErr = Join-Path $runtimeDir "canvas-agent.err.log"

$backendProcess = $null
$webProcess = $null
$agentProcess = $null

try {
    $env:CANVAS_BACKEND_ADDR = "127.0.0.1:8080"
    $env:CANVAS_BACKEND_DATA_DIR = $dataDir
    $env:CANVAS_CORS_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000"
    $env:CANVAS_REGISTRATION_ENABLED = "false"
    # 单机自用工作站：不启用账号容量、每日上传量与素材/画布数量等配额限制。
    $env:CANVAS_SELF_USE_MODE = "1"
    # 纯本地部署没有公网素材地址：允许把参考图以内嵌 data URL 交给上游（图生视频必需）。
    $env:CANVAS_INLINE_MEDIA_URLS = "1"
    $env:ENABLE_PROVIDER_PLUGINS = "false"
    $env:CANVAS_AUTO_MIGRATE = "true"
$backendProcess = Start-Process -FilePath $backendExe -WorkingDirectory $backendDir -WindowStyle Hidden -PassThru -RedirectStandardInput $serviceStdin -RedirectStandardOutput $backendOut -RedirectStandardError $backendErr

    $env:VITE_API_PROXY_TARGET = "http://127.0.0.1:8080"
    # 本地工作站免登录：把 .local\credentials.txt 里的本机账号注入前端进程，打开网页直接进入工作区。
    # 凭据文件缺失时自动跳过，前端会回退到官方登录页。
    $localCredentialFile = Join-Path $localDir "credentials.txt"
    if (Test-Path -LiteralPath $localCredentialFile) {
        $localCredentials = @{}
        foreach ($credentialLine in Get-Content -LiteralPath $localCredentialFile -Encoding UTF8) {
            $credentialPair = $credentialLine -split "=", 2
            if ($credentialPair.Count -eq 2) { $localCredentials[$credentialPair[0].Trim()] = $credentialPair[1].Trim() }
        }
        if ($localCredentials["username"] -and $localCredentials["password"]) {
            $env:VITE_LOCAL_AUTO_LOGIN_USER = $localCredentials["username"]
            $env:VITE_LOCAL_AUTO_LOGIN_PASSWORD = $localCredentials["password"]
            Write-Host "Auto login: enabled for $($localCredentials['username'])" -ForegroundColor Green
        }
    }
$webProcess = Start-Process -FilePath $bunExe -ArgumentList @("run", "dev") -WorkingDirectory $webDir -WindowStyle Hidden -PassThru -RedirectStandardInput $serviceStdin -RedirectStandardOutput $webOut -RedirectStandardError $webErr

    $env:FRAMEFIELD_LOCAL_RUNTIME_CONFIG_DIR = $agentConfigDir
    $env:FRAMEFIELD_TRUSTED_WEB_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000"
$agentProcess = Start-Process -FilePath $nodeExe -ArgumentList @($agentEntry) -WorkingDirectory $agentDir -WindowStyle Hidden -PassThru -RedirectStandardInput $serviceStdin -RedirectStandardOutput $agentOut -RedirectStandardError $agentErr
} finally {
    Remove-Item Env:CANVAS_BACKEND_ADDR, Env:CANVAS_BACKEND_DATA_DIR, Env:CANVAS_CORS_ORIGINS, Env:CANVAS_REGISTRATION_ENABLED, Env:CANVAS_SELF_USE_MODE, Env:CANVAS_INLINE_MEDIA_URLS, Env:ENABLE_PROVIDER_PLUGINS, Env:CANVAS_AUTO_MIGRATE, Env:VITE_API_PROXY_TARGET, Env:VITE_LOCAL_AUTO_LOGIN_USER, Env:VITE_LOCAL_AUTO_LOGIN_PASSWORD, Env:FRAMEFIELD_LOCAL_RUNTIME_CONFIG_DIR, Env:FRAMEFIELD_TRUSTED_WEB_ORIGINS -ErrorAction SilentlyContinue
}

@{ backend = $backendProcess.Id; web = $webProcess.Id; agent = $agentProcess.Id } | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8

function Wait-Endpoint([string]$Url, [int]$TimeoutSeconds = 90) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    throw "Timed out waiting for $Url"
}

Wait-Endpoint "http://127.0.0.1:8080/api/health"
Wait-Endpoint "http://127.0.0.1:3000"
Wait-Endpoint "http://127.0.0.1:17371/health"

Write-Host "Yingce local workstation is running." -ForegroundColor Green
Write-Host "Web:      http://localhost:3000"
Write-Host "Backend:  http://127.0.0.1:8080"
Write-Host "Agent:    http://127.0.0.1:17371"
Write-Host "Data:     $dataDir"
Write-Host "Logs:     $runtimeDir"

Start-Process "http://localhost:3000" | Out-Null
