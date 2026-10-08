# SPDX-License-Identifier: LicenseRef-Yantu-Source-Available
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$skillDir = Join-Path $projectRoot 'plugins\yingce\skills\h3-prompt-writing'
$commit = 'd21241f0a4b3acbb34c97dae47fa417b7065e438'
$source = "https://raw.githubusercontent.com/MiniMax-AI/MiniMax-H3/$commit/skills/h3-prompt-writing"
$guides = @(
    @{ Source = 'SKILL.md'; Target = 'SKILL.md'; Hash = 'a7000443588ca3f145e3b3fd8900f14e0325dc460bd811268fac89a9dc8e56d0' },
    @{ Source = 'agents/openai.yaml'; Target = 'agents/openai.yaml'; Hash = '7770c9d784b7251ab882ee29a738219a3f01811e57ba7fc7822fa83eb8438c1a' },
    @{ Source = 'references/base-en.txt'; Target = 'references/base-en.txt'; Hash = '2cfebc096a6e08370f288d468d90b60f7f9bcb938f94bf090816e910e48e75fc' },
    @{ Source = 'references/ref-en.txt'; Target = 'references/ref-en.txt'; Hash = '1e574f356716ad55612247ffb7bbccbcdb484ad96599d63c7dca1af186b1fab7' }
)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
foreach ($guide in $guides) {
    $target = Join-Path $skillDir $guide.Target
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    if ((Test-Path -LiteralPath $target) -and (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -eq $guide.Hash) { continue }
    $temporary = $target + '.download'
    try {
        Invoke-WebRequest -Uri "$source/$($guide.Source)" -OutFile $temporary -UseBasicParsing -TimeoutSec 45
        if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $guide.Hash) { throw "官方指南校验失败：$($guide.Source)" }
        Move-Item -LiteralPath $temporary -Destination $target -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}
Write-Host "H3 官方指南已按固定提交下载并校验：$commit。其权利与条款归原发布者。"
