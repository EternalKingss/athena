<#
  Athena launcher (portable, win-x64).
  Verifies the vendored runtime against vendor/manifest.json, then boots Athena
  using the vendored Node — no host install, no node_modules.

  Usage:
    .\athena.ps1                 # start the server
    .\athena.ps1 -Doctor         # run the capability self-check and exit
    .\athena.ps1 -Workspace D:\some\project   # scope tools to a target dir
#>
param(
  [string]$Workspace = "",
  [int]$Port = 48991,
  [switch]$Doctor
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$node = Join-Path $root "runtime\win-x64\node\node.exe"
if (-not (Test-Path $node)) { throw "Vendored Node missing at $node. Run setup first." }

# Fail closed if the vendored runtime does not match the pinned hashes.
& $node (Join-Path $root "verify-runtime.mjs") $root
if ($LASTEXITCODE -ne 0) { throw "Runtime verification failed; refusing to launch." }

if ([string]::IsNullOrWhiteSpace($Workspace)) { $Workspace = Join-Path $root "workspace" }
New-Item -ItemType Directory -Force -Path $Workspace, (Join-Path $root "data"), (Join-Path $root "logs") | Out-Null

$env:ATHENA_WORKSPACE = $Workspace
$env:ATHENA_V4_PORT = "$Port"
# Point Athena at a vendored llama-server if one is present (set by the model setup step).
$llama = Join-Path $root "vendor\bin\llama-url.txt"
if (Test-Path $llama) { $env:ATHENA_LLAMA_URL = (Get-Content $llama -Raw).Trim() }

Set-Location $root
$cli = Join-Path $root "dist\cli.js"
if ($Doctor) { & $node $cli doctor; exit $LASTEXITCODE }
Write-Host "Athena starting on 127.0.0.1:$Port (workspace: $Workspace)"
& $node $cli serve
