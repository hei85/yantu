[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$venvDir = Join-Path $projectRoot '.local\image-analysis'
& python -m venv $venvDir
if ($LASTEXITCODE -ne 0) { throw '创建 Python 虚拟环境失败。需要 Python 3.11 或更新版本。' }
& (Join-Path $venvDir 'Scripts\python.exe') -m pip install -r (Join-Path $projectRoot 'canvas-agent\python\requirements.txt') -r (Join-Path $projectRoot 'canvas-agent\python\requirements-lineart.txt')
if ($LASTEXITCODE -ne 0) { throw '图像分析依赖安装失败' }
Write-Host '本地图像分析依赖已安装；模型权重首次使用时下载。请重新启动软件。'
