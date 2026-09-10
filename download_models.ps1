$ErrorActionPreference = 'Continue'

$jobs = @(
  @{ Url = 'https://huggingface.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF/resolve/main/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf?download=true'
     Out = 'D:\ATHENA\runtime\models\Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf' },
  @{ Url = 'https://huggingface.co/unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF/resolve/main/Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf?download=true'
     Out = 'D:\ATHENA\runtime\models\Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf' }
)

foreach ($j in $jobs) {
  Write-Output "=== Starting $($j.Out) at $(Get-Date) ==="
  $attempt = 0
  $done = $false
  while (-not $done -and $attempt -lt 200) {
    $attempt++
    & curl.exe -sS -L -C - --retry 3 --retry-delay 5 --speed-time 30 --speed-limit 1000 -o "$($j.Out)" "$($j.Url)"
    $code = $LASTEXITCODE
    Write-Output "  attempt $attempt exit code $code at $(Get-Date)"
    if ($code -eq 0) {
      $done = $true
    } else {
      Start-Sleep -Seconds 10
    }
  }
  Write-Output "=== Finished $($j.Out): done=$done at $(Get-Date) ==="
}

Write-Output "=== ALL DOWNLOADS COMPLETE at $(Get-Date) ==="
