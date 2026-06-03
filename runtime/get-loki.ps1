# get-loki.ps1 — install Loki malware scanner using the drive's portable Python
# Run get-python.ps1 first if you haven't already.

$Arch = "win-x64"
if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { $Arch = "win-arm64" }

$RuntimeDir = $PSScriptRoot
$RootDir    = Split-Path $RuntimeDir -Parent
$Python     = Join-Path $RuntimeDir "$Arch\python\python.exe"
$Pip        = Join-Path $RuntimeDir "$Arch\python\Scripts\pip.exe"
$LokiDir    = Join-Path $RootDir "tools\loki"

if (-not (Test-Path $Python)) {
  Write-Host "  Portable Python not found. Run runtime\get-python.ps1 first."
  exit 1
}

if (Test-Path (Join-Path $LokiDir "loki.py")) {
  Write-Host "  Loki already installed at $LokiDir"
  exit 0
}

Write-Host "  Cloning Loki..."
New-Item -ItemType Directory -Force -Path (Join-Path $RootDir "tools") | Out-Null
git clone --depth 1 https://github.com/Neo23x0/Loki $LokiDir
if ($LASTEXITCODE -ne 0) { Write-Host "  ERROR: git clone failed"; exit 1 }

Write-Host "  Installing dependencies into drive Python..."
& $Pip install --quiet -r (Join-Path $LokiDir "requirements.txt")
if ($LASTEXITCODE -ne 0) { Write-Host "  ERROR: pip install failed"; exit 1 }

Write-Host ""
Write-Host "  Loki ready. Run a scan:"
Write-Host "    $Python $LokiDir\loki.py --path C:\target"
Write-Host ""
Write-Host "  First run — update signatures:"
Write-Host "    $Python $LokiDir\loki.py --update"
