param(
    [string]$Destination = (Join-Path $env:USERPROFILE '.claude\skills\safe-ops')
)

$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $MyInvocation.MyCommand.Path

New-Item -ItemType Directory -Path $Destination -Force | Out-Null
Copy-Item (Join-Path $source 'SKILL.md') $Destination -Force
Copy-Item (Join-Path $source 'README.md') $Destination -Force
Copy-Item (Join-Path $source 'LICENSE') $Destination -Force

$bin = Join-Path $Destination 'bin'
if (Test-Path $bin) { Remove-Item $bin -Recurse -Force }
Copy-Item (Join-Path $source 'bin') $Destination -Recurse -Force

Write-Host "installed safe-ops -> $Destination"
Write-Host "try: node `"$Destination\bin\safetrash.cjs`" plan --path .\build"
