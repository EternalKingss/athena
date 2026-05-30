---
name: system-health
description: Full system health check — CPU, RAM, disk, network, temps, top processes
---

# System Health Check

Run these in order and summarise findings. Flag anything that looks wrong.

## CPU & load
```
uptime
top -bn1 | head -20
```

## Memory
```
free -h
cat /proc/meminfo | grep -E 'MemTotal|MemFree|MemAvailable|SwapTotal|SwapFree'
```

## Disk
```
df -h
iostat -x 1 1 2>/dev/null || echo "iostat not available"
```

## Network
```
ping -c 3 8.8.8.8
ip addr show
ss -tuln
```

## Temperature (if available)
```
sensors 2>/dev/null || echo "lm-sensors not installed"
cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | awk '{print $1/1000 "°C"}'
```

## Top processes
```
ps aux --sort=-%cpu | head -10
ps aux --sort=-%mem | head -10
```

## Recent errors
```
dmesg | tail -20
journalctl -p err -n 20 --no-pager 2>/dev/null
```

## Summary format
After running, report:
- Overall health: Good / Warning / Critical
- CPU load (and if high, what's using it)
- RAM usage and if swap is being used
- Disk usage (flag any partition over 80%)
- Network reachability
- Any errors found
