---
name: remove-mcafee-windows
description: Safely identify, uninstall, and verify McAfee/WebAdvisor removal on Windows while confirming Defender is active
created: 2026-05-31
---

# Remove McAfee on Windows

Use when the user approves uninstalling McAfee/WebAdvisor to reduce background load.

## Rules
- Use official uninstall commands from Windows uninstall registry.
- Do not delete McAfee folders manually as the primary method.
- Tell user to accept UAC prompts and choose full remove/uninstall if GUI appears.
- Verify Windows Defender / Windows Security is active afterward.

## 1) Find installed McAfee products
```powershell
$keys=@(
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
Get-ItemProperty $keys -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match 'McAfee|WebAdvisor|LiveSafe|Total Protection|Security Scan' } |
  Select-Object DisplayName,DisplayVersion,Publisher,UninstallString,QuietUninstallString,PSChildName |
  Format-List
```

## 2) Run official uninstallers
Prefer `QuietUninstallString` if present and clearly safe. Otherwise run `UninstallString` with `Start-Process -Wait`.

Known examples:
```powershell
Start-Process -FilePath 'C:\Program Files\McAfee\wps\<version>\mc-update.exe' -ArgumentList '/uninstall' -Wait
Start-Process -FilePath 'C:\Program Files\McAfee\WebAdvisor\Uninstaller.exe' -Wait
```

If GUI appears, user should select **Remove/Uninstall everything**, not keep protection/browser extensions.

## 3) Verify removal
```powershell
$keys=@(
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
Write-Host '=== INSTALLED MCAFEE ITEMS ==='
Get-ItemProperty $keys -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match 'McAfee|WebAdvisor|LiveSafe|Total Protection|Security Scan' } |
  Select-Object DisplayName,DisplayVersion,Publisher |
  Format-Table -AutoSize

Write-Host '=== MCAFEE PROCESSES ==='
Get-Process |
  Where-Object { $_.ProcessName -match 'mcafee|mc-|mfe|webadvisor' } |
  Select-Object ProcessName,Id,CPU,@{n='MemMB';e={[math]::Round($_.WorkingSet64/1MB,1)}} |
  Format-Table -AutoSize

Write-Host '=== MCAFEE SERVICES ==='
Get-CimInstance Win32_Service |
  Where-Object { $_.Name -match 'mcafee|mfe|mc-|webadvisor' -or $_.DisplayName -match 'McAfee|WebAdvisor' } |
  Select-Object Name,DisplayName,State,StartMode |
  Format-Table -AutoSize
```

No output under installed items/processes/services means McAfee is removed.

## 4) Confirm Windows Security is active
```powershell
Get-MpComputerStatus |
  Select-Object AMServiceEnabled,AntivirusEnabled,RealTimeProtectionEnabled,AntispywareEnabled,FullScanAge,QuickScanAge |
  Format-List
```

Expected: `AMServiceEnabled=True`, `AntivirusEnabled=True`, `RealTimeProtectionEnabled=True`.

## 5) Finish
Recommend restart to unload drivers/hooks and finish cleanup.
