---
name: system-health
description: Full system health check — CPU, RAM, disk, network, temps, top processes. Covers Windows, Linux, and macOS.
---

# System Health Check

Detect the platform first (`process.platform`), then run the appropriate section below.
Run all commands and summarize findings. Flag anything that looks wrong.

---

## WINDOWS

### Snapshot (PowerShell)
```powershell
$ErrorActionPreference='SilentlyContinue'
Write-Host '=== SYSTEM ==='
Get-CimInstance Win32_OperatingSystem | Select Caption,Version,LastBootUpTime,FreePhysicalMemory,TotalVisibleMemorySize | Format-List
Write-Host '=== CPU ==='
Get-CimInstance Win32_Processor | Select Name,NumberOfCores,LoadPercentage,MaxClockSpeed | Format-List
Write-Host '=== MEMORY ==='
Get-CimInstance Win32_OperatingSystem | % {
  $total=[math]::Round($_.TotalVisibleMemorySize/1MB,2)
  $free=[math]::Round($_.FreePhysicalMemory/1MB,2)
  $used=[math]::Round($total-$free,2)
  [pscustomobject]@{TotalGB=$total; UsedGB=$used; FreeGB=$free; UsedPct=[math]::Round(($used/$total)*100,1)}
} | Format-List
Write-Host '=== DISKS ==='
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select DeviceID,@{n='SizeGB';e={[math]::Round($_.Size/1GB,1)}},@{n='FreeGB';e={[math]::Round($_.FreeSpace/1GB,1)}},@{n='UsedPct';e={[math]::Round((($_.Size-$_.FreeSpace)/$_.Size)*100,1)}} | Format-Table -AutoSize
Write-Host '=== TOP CPU PROCESSES ==='
$cores=(Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
Get-Counter '\Process(*)\% Processor Time' -SampleInterval 1 -MaxSamples 2 | Select -Last 1 -ExpandProperty CounterSamples | ? {$_.InstanceName -notin @('_total','idle') -and $_.CookedValue -gt 1} | Sort CookedValue -Desc | Select -First 12 @{n='Process';e={$_.InstanceName}},@{n='CPU%';e={[math]::Round($_.CookedValue/$cores,1)}} | Format-Table -AutoSize
Write-Host '=== TOP MEMORY PROCESSES ==='
Get-Process | Sort WorkingSet64 -Desc | Select -First 12 ProcessName,@{n='MemMB';e={[math]::Round($_.WorkingSet64/1MB,1)}} | Format-Table -AutoSize
Write-Host '=== NETWORK ==='
Get-NetAdapter | Where Status -eq Up | Select Name,InterfaceDescription,LinkSpeed | Format-Table -AutoSize
Test-NetConnection -ComputerName 8.8.8.8 -Port 53 -InformationLevel Quiet
Write-Host '=== RECENT ERRORS (last 24h) ==='
Get-WinEvent -FilterHashtable @{LogName='System';Level=1,2;StartTime=(Get-Date).AddHours(-24)} -MaxEvents 10 -ErrorAction SilentlyContinue | Select TimeCreated,ProviderName,Message | Format-List
```

---

## LINUX

### CPU & load
```
uptime
top -bn1 | head -20
```

### Memory
```
free -h
cat /proc/meminfo | grep -E 'MemTotal|MemFree|MemAvailable|SwapTotal|SwapFree'
```

### Disk
```
df -h
iostat -x 1 1 2>/dev/null || echo "iostat not available"
```

### Network
```
ping -c 3 8.8.8.8
ip addr show
ss -tuln
```

### Temperature (if available)
```
sensors 2>/dev/null || echo "lm-sensors not installed"
cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | awk '{print $1/1000 "°C"}'
```

### Top processes
```
ps aux --sort=-%cpu | head -10
ps aux --sort=-%mem | head -10
```

### Recent errors
```
dmesg | tail -20
journalctl -p err -n 20 --no-pager 2>/dev/null
```

---

## macOS

```bash
uptime
vm_stat | awk 'NR<=10'
df -h
top -l 2 -n 10 -o cpu | tail -20
ping -c 3 8.8.8.8
ifconfig | grep -E 'inet |status'
log show --style compact --predicate 'messageType == 16' --last 1h 2>/dev/null | tail -20
```

---

## Summary format
After running, report:
- Overall health: Good / Warning / Critical
- CPU: current load and top consumer if high
- RAM: usage % and whether swap is active
- Disk: usage per drive (flag anything over 80%)
- Network: reachability to 8.8.8.8
- Any errors or events that need attention
- Exact next action if anything is wrong