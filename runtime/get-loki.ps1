# get-loki.ps1 — download Loki-RS malware scanner binary onto the drive
# Usage: .\get-loki.ps1
# Drops loki-rs.exe into runtime\<arch>\

param(
  [string]$Version = "0.4.0"
)

$Arch = "win-x64"
if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { $Arch = "win-arm64" }

$Triple     = if ($Arch -eq "win-arm64") { "aarch64-pc-windows-msvc" } else { "x86_64-pc-windows-msvc" }
$FileName   = "loki-rs-$Triple.zip"
$Url        = "https://github.com/Neo23x0/Loki-RS/releases/download/v$Version/$FileName"
$RuntimeDir = Join-Path $PSScriptRoot $Arch
$TargetExe  = Join-Path $RuntimeDir "loki-rs.exe"
$TmpZip     = Join-Path $RuntimeDir "_loki_tmp.zip"

if (Test-Path $TargetExe) {
  Write-Host "  Loki-RS already present at $TargetExe"
  exit 0
}

Write-Host "  Downloading Loki-RS v$Version for $Arch..."
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
try {
  Invoke-WebRequest -Uri $Url -OutFile $TmpZip -UseBasicParsing
} catch {
  Write-Host "  ERROR: $_"; exit 1
}

Write-Host "  Extracting..."
$TmpDir = Join-Path $RuntimeDir "_loki_extract"
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
Expand-Archive -Path $TmpZip -DestinationPath $TmpDir -Force
$Exe = Get-ChildItem -Path $TmpDir -Filter "loki-rs.exe" -Recurse | Select-Object -First 1
if ($Exe) {
  Copy-Item $Exe.FullName $TargetExe -Force
} else {
  Write-Host "  ERROR: loki-rs.exe not found in archive"; exit 1
}
Remove-Item $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $TmpZip -Force          -ErrorAction SilentlyContinue

Write-Host "  Loki-RS ready at: $TargetExe"
