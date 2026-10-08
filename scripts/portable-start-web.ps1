[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$portableRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$nodeRuntime = Join-Path $portableRoot 'runtime\node.exe'
$webRuntime = Join-Path $portableRoot 'scripts\serve-web.mjs'
$logRoot = Join-Path $portableRoot '.local\runtime'
$pidRecordFile = Join-Path $logRoot 'pids.json'

foreach ($requiredFile in @($nodeRuntime, $webRuntime)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) { throw "Missing portable component: $requiredFile" }
}
if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) {
    Write-Host 'Web port 3000 is already listening; no process was started.'
    exit 0
}

New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$stdinFile = Join-Path $logRoot 'stdin.txt'
if (-not (Test-Path -LiteralPath $stdinFile)) { New-Item -ItemType File -Path $stdinFile | Out-Null }
$priorErrorFile = Join-Path $logRoot 'web.err.log'
if (Test-Path -LiteralPath $priorErrorFile) {
    Copy-Item -LiteralPath $priorErrorFile -Destination (Join-Path $logRoot ('web.before-recovery-' + (Get-Date).ToString('yyyyMMdd-HHmmss') + '.err.log'))
}
$env:PORTABLE_WEB_PORT = '3000'
$env:PORTABLE_API_TARGET = 'http://127.0.0.1:8080'
$webProcess = Start-Process -FilePath $nodeRuntime -ArgumentList @('"' + $webRuntime + '"') -WorkingDirectory $portableRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardInput $stdinFile `
    -RedirectStandardOutput (Join-Path $logRoot 'web.log') `
    -RedirectStandardError (Join-Path $logRoot 'web.err.log')

$pidRecord = if (Test-Path -LiteralPath $pidRecordFile) { Get-Content -LiteralPath $pidRecordFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
$pidRecord | Add-Member -NotePropertyName web -NotePropertyValue $webProcess.Id -Force
$pidRecord | Add-Member -NotePropertyName webRestartedAt -NotePropertyValue (Get-Date).ToString('o') -Force
$pidRecord | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $pidRecordFile -Encoding utf8

for ($attempt=0; $attempt -lt 30; $attempt++) {
    try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/' -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -eq 200) { Write-Host 'Web service restored: http://localhost:3000/'; exit 0 }
    } catch { Start-Sleep -Milliseconds 200 }
}
throw 'Web service startup did not become ready; inspect .local/runtime/web.err.log.'
