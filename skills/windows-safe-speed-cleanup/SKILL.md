---
name: windows-safe-speed-cleanup
description: Safe Windows slowdown triage and cleanup: health snapshot, startup drag, temp cleanup, live CPU checks
created: 2026-05-31
---

# Windows Safe Speed Cleanup

Use this when a Windows machine is slow and the user asks for a full check/cleanup.

## Rules
- Do safe cleanup only unless user explicitly approves risky changes.
- Do **not** use registry cleaners or random “optimizer” tools.
- Do not write working scripts inside the ATHENA drive. Use `%LOCALAPPDATA%\Temp`.
- If DISM component cleanup is needed, it requires an elevated/admin shell.

## 1) Baseline health snapshot
Run:
```powershell
$ErrorActionPreference='SilentlyContinue'
Write-Host '=== SYSTEM ==='
Get-CimInstance Win32_OperatingSystem | Select Caption,Version,LastBootUpTime,FreePhysicalMemory,TotalVisibleMemorySize | Format-List
Write-Host '=== CPU ==='
Get-CimInstance Win32_Processor | Select Name,NumberOfCores,NumberOfLogicalProcessors,LoadPercentage,MaxClockSpeed | Format-List
Write-Host '=== MEMORY ==='
Get-CimInstance Win32_OperatingSystem | % {
  $total=[math]::Round($_.TotalVisibleMemorySize/1MB,2)
  $free=[math]::Round($_.FreePhysicalMemory/1MB,2)
  $used=[math]::Round($total-$free,2)
  [pscustomobject]@{TotalGB=$total; UsedGB=$used; FreeGB=$free; UsedPercent=[math]::Round(($used/$total)*100,1)}
} | Format-List
Write-Host '=== DISKS ==='
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select DeviceID,VolumeName,@{n='SizeGB';e={[math]::Round($_.Size/1GB,2)}},@{n='FreeGB';e={[math]::Round($_.FreeSpace/1GB,2)}},@{n='UsedPercent';e={[math]::Round((($_.Size-$_.FreeSpace)/$_.Size)*100,1)}} | Format-Table -AutoSize
Write-Host '=== TOP MEMORY ==='
Get-Process | Sort WorkingSet64 -Descending | Select -First 12 ProcessName,Id,@{n='MemMB';e={[math]::Round($_.WorkingSet64/1MB,1)}},CPU | Format-Table -AutoSize
```

## 2) Startup and background drag
```powershell
Write-Host '=== STARTUP PROGRAMS ==='
Get-CimInstance Win32_StartupCommand | Select Name,Command,Location,User | Format-Table -Wrap -AutoSize
Write-Host '=== AUTO RUNNING 3RD PARTY-ish SERVICES ==='
Get-CimInstance Win32_Service | ? {$_.StartMode -eq 'Auto' -and $_.State -eq 'Running' -and $_.PathName -notmatch 'Windows|System32|Microsoft'} | Select Name,DisplayName,State,StartMode,PathName | Format-Table -Wrap -AutoSize
Write-Host '=== RECENT SYSTEM ERRORS ==='
Get-WinEvent -FilterHashtable @{LogName='System'; Level=1,2; StartTime=(Get-Date).AddDays(-3)} -MaxEvents 15 | Select TimeCreated,ProviderName,Id,LevelDisplayName,Message | Format-List
```

## 3) Safe cleanup
```powershell
$ErrorActionPreference='SilentlyContinue'
$before=(Get-PSDrive C).Free
$paths=@(
  $env:TEMP,
  'C:\Windows\Temp',
  (Join-Path $env:LOCALAPPDATA 'Temp'),
  (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\INetCache'),
  (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\WebCache')
)
$removed=0
foreach($p in $paths){
  if(Test-Path $p){
    Get-ChildItem -LiteralPath $p -Force -Recurse -ErrorAction SilentlyContinue | % {
      try {
        $size=0; if(-not $_.PSIsContainer){$size=$_.Length}
        Remove-Item -LiteralPath $_.FullName -Force -Recurse -ErrorAction Stop
        $script:removed += $size
      } catch {}
    }
  }
}
Clear-RecycleBin -Force -ErrorAction SilentlyContinue
ipconfig /flushdns | Out-Null
$after=(Get-PSDrive C).Free
[pscustomobject]@{FreedByFileDeletesGB=[math]::Round($removed/1GB,3); CFreeBeforeGB=[math]::Round($before/1GB,2); CFreeAfterGB=[math]::Round($after/1GB,2); NetChangeGB=[math]::Round(($after-$before)/1GB,3)} | Format-List
```

## 4) Live CPU measurement
Do not rely only on cumulative `Get-Process CPU`. Use counters:
```powershell
$cores=(Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
Get-Counter '\Process(*)\% Processor Time' -SampleInterval 1 -MaxSamples 2 |
  Select -Last 1 -ExpandProperty CounterSamples |
  ? {$_.InstanceName -notin @('_total','idle') -and $_.CookedValue -gt 1} |
  Sort CookedValue -Descending |
  Select -First 15 @{n='Process';e={$_.InstanceName}},@{n='CPUPercent';e={[math]::Round($_.CookedValue/$cores,1)}} |
  Format-Table -AutoSize
```

## 5) Common safe startup cleanup
Remove Edge auto-launch from current user startup if present:
```powershell
$run='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$edge=(Get-ItemProperty -Path $run).PSObject.Properties | ? {$_.Name -like 'MicrosoftEdgeAutoLaunch*'}
foreach($e in $edge){ Remove-ItemProperty -Path $run -Name $e.Name -Force }
```

Stop duplicate/stuck installers only when clearly transient:
```powershell
Get-Process OneDriveSetup -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
```

## 6) Admin-only follow-up
If admin is available:
```powershell
dism /Online /Cleanup-Image /AnalyzeComponentStore
dism /Online /Cleanup-Image /StartComponentCleanup
sfc /scannow
```

## Report format
- Overall health: Good / Warning / Critical
- What improved
- Current CPU/RAM/disk
- Main remaining suspects
- Exact next actions requiring approval/admin
