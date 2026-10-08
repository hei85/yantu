# SPDX-License-Identifier: LicenseRef-Yantu-Source-Available
[CmdletBinding()]
param([switch]$AcceptUpstreamLicenses)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Write-Host 'Optional OpenPose / lineart weights are supplied by their upstream authors.'
Write-Host 'OpenPose license: https://github.com/CMU-Perceptual-Computing-Lab/openpose/blob/master/LICENSE'
Write-Host 'Annotators terms: https://huggingface.co/lllyasviel/Annotators'
Write-Host 'OpenPose has non-commercial restrictions. Obtain commercial permission where required.'
if (-not $AcceptUpstreamLicenses) {
    $answer = Read-Host 'Only continue if your intended use is permitted by the upstream terms. Type ACCEPT to continue'
    if ($answer -cne 'ACCEPT') { Write-Host 'No optional weights were downloaded.'; exit 0 }
}
$python = Join-Path $root 'python-runtime\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'Run this installer from the complete portable package.' }
$env:PYTHONHOME = Join-Path $root 'python-runtime'
$env:PYTHONPATH = ''
$env:PYTHONNOUSERSITE = '1'
$env:HF_HOME = Join-Path $root 'models\huggingface'
$env:HF_HUB_OFFLINE = '0'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
$code = @'
from huggingface_hub import hf_hub_download
revision = "982e7edaec38759d914a963c48c4726685de7d96"
for filename in ("body_pose_model.pth", "sk_model.pth", "sk_model2.pth"):
    hf_hub_download("lllyasviel/Annotators", filename, revision=revision)
from pathlib import Path
import os
ref = Path(os.environ["HF_HOME"]) / "hub/models--lllyasviel--Annotators/refs/main"
ref.parent.mkdir(parents=True, exist_ok=True)
ref.write_text(revision, encoding="utf-8")
print("Optional weights downloaded. Restart the application to refresh availability.")
'@
& $python -c $code
if ($LASTEXITCODE -ne 0) { throw 'Optional model download failed. Core application remains available.' }
