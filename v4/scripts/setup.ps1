$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
Write-Output "Athena v4 setup verifies vendor/manifest.json before first boot."
node dist/cli.js doctor
