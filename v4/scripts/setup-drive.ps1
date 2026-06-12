<#
  Phase VI setup: provision a portable Athena onto a target drive (win-x64).
  - vendors the exact Node from vendor/manifest.json (verified against nodejs.org SHASUMS)
  - deploys dist/, the manifest, the runtime verifier, and the launchers
  - runs the boot gate so a bad/incomplete drive fails closed

  Usage:  .\setup-drive.ps1 -Target D:\Athena
#>
param([Parameter(Mandatory = $true)][string]$Target)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$scripts = $PSScriptRoot
$v4 = Split-Path $scripts -Parent
$manifest = Get-Content (Join-Path $v4 "vendor\manifest.json") -Raw | ConvertFrom-Json
$ver = "v" + $manifest.node.version

$dirs = @("$Target", "$Target\dist", "$Target\runtime\win-x64\node", "$Target\vendor\models", "$Target\vendor\bin", "$Target\data", "$Target\logs", "$Target\workspace", "$Target\_staging")
foreach ($d in $dirs) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

$nodeExe = Join-Path $Target "runtime\win-x64\node\node.exe"
if (-not (Test-Path $nodeExe)) {
  $name = "node-$ver-win-x64.zip"
  $zip = Join-Path $Target "_staging\$name"
  Write-Host "Vendoring Node $ver ..."
  Invoke-WebRequest -Uri "https://nodejs.org/dist/$ver/$name" -OutFile $zip -UseBasicParsing
  Invoke-WebRequest -Uri "https://nodejs.org/dist/$ver/SHASUMS256.txt" -OutFile (Join-Path $Target "_staging\SHASUMS.txt") -UseBasicParsing
  $expected = (Select-String -Path (Join-Path $Target "_staging\SHASUMS.txt") -Pattern ([regex]::Escape($name)) | Select-Object -First 1).Line.Split(" ")[0]
  $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($expected -ne $actual) { throw "Node zip hash mismatch ($expected vs $actual)" }
  Expand-Archive -Path $zip -DestinationPath (Join-Path $Target "_staging\nx") -Force
  $exe = Get-ChildItem (Join-Path $Target "_staging\nx") -Recurse -Filter node.exe | Select-Object -First 1
  Copy-Item $exe.FullName $nodeExe -Force
}

Copy-Item (Join-Path $v4 "dist\*") (Join-Path $Target "dist") -Recurse -Force
Copy-Item (Join-Path $v4 "vendor\manifest.json") (Join-Path $Target "vendor\manifest.json") -Force
Copy-Item (Join-Path $scripts "verify-runtime.mjs") (Join-Path $Target "verify-runtime.mjs") -Force
Copy-Item (Join-Path $scripts "athena.ps1") (Join-Path $Target "athena.ps1") -Force
Copy-Item (Join-Path $scripts "athena.cmd") (Join-Path $Target "athena.cmd") -Force
Remove-Item (Join-Path $Target "_staging") -Recurse -Force -ErrorAction SilentlyContinue

& $nodeExe (Join-Path $Target "verify-runtime.mjs") $Target
if ($LASTEXITCODE -ne 0) { throw "Runtime verification failed after setup." }
Write-Host "Athena provisioned at $Target. Launch with: $Target\athena.cmd"
