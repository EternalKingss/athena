# get-offline.ps1 -- download llama-server binary + Phi-3.5-mini model for offline AI
# Run from PowerShell: .\runtime\get-offline.ps1
# After this runs, Athena works with no internet or API keys.

$ErrorActionPreference = 'Stop'
$DIR = Split-Path -Parent $MyInvocation.MyCommand.Path

# Detect arch
$ARCH = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
$LLAMA_DIR = Join-Path $DIR "$ARCH\llama"
$LLAMA_BIN = Join-Path $LLAMA_DIR 'llama-server.exe'
$MODELS_DIR = Join-Path $DIR 'models'
$MODEL_FILE = Join-Path $MODELS_DIR 'Phi-3.5-mini-instruct-Q4_K_M.gguf'
$MODEL_URL  = 'https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf'

New-Item -ItemType Directory -Force -Path $LLAMA_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $MODELS_DIR | Out-Null

# Disk space check
$drive = Split-Path -Qualifier $DIR
$disk  = Get-PSDrive ($drive.TrimEnd(':'))
$freeGB = [math]::Round($disk.Free / 1GB, 1)
if ($freeGB -lt 3) {
  Write-Host "  WARNING: only ${freeGB} GB free -- need ~3 GB for model + binary"
  $confirm = Read-Host "  Continue anyway? [y/N]"
  if ($confirm -ne 'y') { exit 1 }
}

# Download llama-server binary
if (Test-Path $LLAMA_BIN) {
  Write-Host "  llama-server already present at $LLAMA_BIN"
} else {
  Write-Host "  Fetching latest llama.cpp release tag..."
  $release = Invoke-RestMethod 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest'
  $tag = $release.tag_name
  Write-Host "  Latest release: $tag"

  $zipName = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
    "llama-${tag}-bin-win-arm64.zip"
  } else {
    "llama-${tag}-bin-win-x64.zip"
  }
  $zipUrl = "https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${zipName}"
  $tmpZip = Join-Path $LLAMA_DIR '_llama_tmp.zip'

  Write-Host "  Downloading $zipName..."
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $zipUrl -OutFile $tmpZip -UseBasicParsing
  Write-Host "  Extracting llama-server.exe..."

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($tmpZip)
  $entry = $zip.Entries | Where-Object { $_.Name -eq 'llama-server.exe' } | Select-Object -First 1
  if (-not $entry) { Write-Host '  ERROR: llama-server.exe not found in archive'; exit 1 }
  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $LLAMA_BIN, $true)
  $zip.Dispose()
  Remove-Item $tmpZip -Force

  Write-Host "  Binary installed: $LLAMA_BIN"
}

# Verify binary
try {
  & $LLAMA_BIN --version 2>&1 | Out-Null
  Write-Host "  llama-server binary OK"
} catch {
  Write-Host "  WARNING: binary test failed (may still work)"
}

# Download model
if (Test-Path $MODEL_FILE) {
  Write-Host "  Model already present: $MODEL_FILE"
} else {
  Write-Host ""
  Write-Host "  Downloading Phi-3.5-mini-instruct Q4_K_M (~2.2 GB)..."
  Write-Host "  Source: HuggingFace / bartowski"
  $tmpModel = "$MODEL_FILE.tmp"
  $ProgressPreference = 'Continue'
  Invoke-WebRequest -Uri $MODEL_URL -OutFile $tmpModel -UseBasicParsing
  Rename-Item -Path $tmpModel -NewName (Split-Path -Leaf $MODEL_FILE)
  Write-Host "  Model installed: $MODEL_FILE"
}

Write-Host ""
Write-Host "  Done! Athena is now offline-capable."
Write-Host "    Binary: $LLAMA_BIN"
Write-Host "    Model:  $MODEL_FILE"
Write-Host ""
Write-Host "  Start Athena without any API key -- it will use the local model."
Write-Host ""
