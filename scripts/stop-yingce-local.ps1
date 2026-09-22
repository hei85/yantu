[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$pidFile = Join-Path $repoRoot ".local\runtime\pids.json"

function Stop-ProcessTree([int]$ProcessId) {
    if ($ProcessId -le 0) { return }
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue
    foreach ($child in $children) {
        Stop-ProcessTree ([int]$child.ProcessId)
    }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $pidFile) {
    $pids = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    foreach ($name in @("backend", "web", "agent")) {
        $processId = [int]$pids.$name
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($process) { Stop-ProcessTree $processId }
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

foreach ($port in @(3000, 8080, 17371)) {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $listener) { continue }
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    $commandLine = [string]$processInfo.CommandLine
    $executablePath = [string]$processInfo.ExecutablePath
    if ($commandLine.IndexOf($repoRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $executablePath.IndexOf($repoRoot, [StringComparison]::OrdinalIgnoreCase) -eq 0) {
        Stop-ProcessTree ([int]$listener.OwningProcess)
    } else {
        Write-Warning "Port $port is owned by another process and was left running."
    }
}

Write-Host "Yingce local workstation stopped." -ForegroundColor Green
