param(
  [string]$Arch = "win-x64",
  [string]$Version = "v22.16.0",
  [string]$RuntimeDir
)

$ZipName = "node-$Version-$Arch.zip"
$ZipPath = Join-Path $RuntimeDir $ZipName
$TargetDir = Join-Path $RuntimeDir $Arch
$Url = "https://nodejs.org/dist/$Version/$ZipName"

Write-Host "  Downloading Node $Version for $Arch..."
try {
  Invoke-WebRequest -Uri $Url -OutFile $ZipPath -UseBasicParsing
} catch {
  Write-Host "  ERROR downloading: $_"
  exit 1
}

Write-Host "  Extracting..."
$TmpDir = Join-Path $RuntimeDir "_tmp_node"
Expand-Archive -Path $ZipPath -DestinationPath $TmpDir -Force
$Inner = Get-ChildItem $TmpDir | Select-Object -First 1
New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
Copy-Item -Path (Join-Path $Inner.FullName "*") -Destination $TargetDir -Recurse -Force
Remove-Item $TmpDir -Recurse -Force
Remove-Item $ZipPath -Force

Write-Host "  Node ready."
