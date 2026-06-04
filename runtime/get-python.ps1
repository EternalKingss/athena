# get-python.ps1 — download python-build-standalone onto the drive (no host install)
# Usage: .\get-python.ps1
# Drops portable Python into runtime\<arch>\python\

param(
  [string]$Version  = "3.13.3",
  [string]$Date     = "20250517"
)

$Arch = "win-x64"
if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { $Arch = "win-arm64" }

$Triple = if ($Arch -eq "win-arm64") { "aarch64-pc-windows-msvc" } else { "x86_64-pc-windows-msvc" }

$FileName  = "cpython-$Version+$Date-$Triple-install_only.tar.gz"
$Url       = "https://github.com/indygreg/python-build-standalone/releases/download/$Date/$FileName"
$RuntimeDir = Join-Path $PSScriptRoot $Arch
$TargetDir  = Join-Path $RuntimeDir "python"
$TmpFile    = Join-Path $RuntimeDir "_python_tmp.tar.gz"

if (Test-Path (Join-Path $TargetDir "python.exe")) {
  Write-Host "  Portable Python already present at $TargetDir"
  exit 0
}

Write-Host "  Downloading Python $Version for $Arch..."
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
try {
  Invoke-WebRequest -Uri $Url -OutFile $TmpFile -UseBasicParsing
} catch {
  Write-Host "  ERROR: $_"; exit 1
}

Write-Host "  Extracting..."
# Use tar (available on Windows 10+)
$TmpDir = Join-Path $RuntimeDir "_python_extract"
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
tar -xzf $TmpFile -C $TmpDir
# python-build-standalone extracts to a 'python' subfolder
$Extracted = Join-Path $TmpDir "python"
if (Test-Path $Extracted) {
  if (Test-Path $TargetDir) { Remove-Item $TargetDir -Recurse -Force }
  Move-Item $Extracted $TargetDir
} else {
  Write-Host "  ERROR: unexpected archive structure"; exit 1
}
Remove-Item $TmpDir  -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $TmpFile -Force          -ErrorAction SilentlyContinue

Write-Host "  Portable Python ready at: $TargetDir\python.exe"
Write-Host "  Run: $TargetDir\python.exe --version"
