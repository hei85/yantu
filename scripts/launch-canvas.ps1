# SPDX-License-Identifier: LicenseRef-Yantu-Source-Available
[CmdletBinding()]
param([switch]$Rebuild, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'start-axon.ps1') -Rebuild:$Rebuild -NoBrowser:$NoBrowser
