<#
  Vendor the offline brain onto the drive: a portable llama.cpp server (CPU build)
  and a GGUF model. Writes vendor/bin/llama-url.txt (read by athena.ps1) and a
  start-llama.cmd launcher, and prints the SHA-256 of each artifact so they can be
  pinned in vendor/manifest.json.

  Usage:
    .\setup-model.ps1 -Target D:\Athena
#>
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [string]$LlamaZipUrl = "https://github.com/ggml-org/llama.cpp/releases/download/b9601/llama-b9601-bin-win-cpu-x64.zip",
  [string]$ModelUrl = "https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
  [string]$ModelFile = "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
  [int]$Context = 8192
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$binDir = Join-Path $Target "vendor\bin\llama"
$modelDir = Join-Path $Target "vendor\models"
$staging = Join-Path $Target "_model_staging"
New-Item -ItemType Directory -Force -Path $binDir, $modelDir, $staging | Out-Null

# 1) llama.cpp server (small)
Write-Host "Downloading llama.cpp server ..."
$llamaZip = Join-Path $staging "llama.zip"
Invoke-WebRequest -Uri $LlamaZipUrl -OutFile $llamaZip -UseBasicParsing
Expand-Archive -Path $llamaZip -DestinationPath (Join-Path $staging "llama") -Force
$payload = Get-ChildItem (Join-Path $staging "llama") -Recurse -Include "llama-server.exe", "*.dll" | Select-Object -ExpandProperty FullName
foreach ($file in $payload) { Copy-Item $file $binDir -Force }
$server = Join-Path $binDir "llama-server.exe"
if (-not (Test-Path $server)) { throw "llama-server.exe not found in release zip" }

# 2) model (large; resumable)
$modelPath = Join-Path $modelDir $ModelFile
Write-Host "Downloading model $ModelFile (this is multi-GB) ..."
& curl.exe -L -C - --fail --retry 3 -o $modelPath $ModelUrl
if ($LASTEXITCODE -ne 0) { throw "Model download failed (curl exit $LASTEXITCODE)" }
$sizeGB = [math]::Round((Get-Item $modelPath).Length / 1GB, 2)
if ($sizeGB -lt 1) { throw "Model file looks too small ($sizeGB GB)" }

# 3) launcher + endpoint marker
Set-Content -Path (Join-Path $Target "vendor\bin\llama-url.txt") -Value "http://127.0.0.1:8080" -Encoding ascii -NoNewline
$startCmd = @"
@echo off
"%~dp0vendor\bin\llama\llama-server.exe" -m "%~dp0vendor\models\$ModelFile" --host 127.0.0.1 --port 8080 -c $Context -t %NUMBER_OF_PROCESSORS%
"@
Set-Content -Path (Join-Path $Target "start-llama.cmd") -Value $startCmd -Encoding ascii

Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue

$serverHash = (Get-FileHash $server -Algorithm SHA256).Hash.ToLower()
$modelHash = (Get-FileHash $modelPath -Algorithm SHA256).Hash.ToLower()
Write-Host "DONE."
Write-Host "llama-server.exe sha256 = $serverHash"
Write-Host "$ModelFile sha256 = $modelHash"
Write-Host "model size = $sizeGB GB"
Write-Host "Start the brain with: $Target\start-llama.cmd  (then launch athena.cmd)"
