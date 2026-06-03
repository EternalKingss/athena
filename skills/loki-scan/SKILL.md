---
name: loki-scan
description: Scan files or directories for malware using Loki-RS (YARA + IOC scanner). Bundled on the drive — no host install needed.
---

# Loki Malware Scanner

Loki-RS is a high-performance YARA + IOC scanner bundled in `runtime/<arch>/loki-rs`.
It runs entirely from the drive. Nothing is installed on the host.

## Check if Loki-RS is available

Use `machine_info` to check `bundled.lokiRs`. If `true`, the binary is ready.
The binary path is always `runtime/<arch>/loki-rs` (or `loki-rs.exe` on Windows).

To find the exact path at runtime, use `run_shell`:
```
# Linux/macOS
ls -la runtime/linux-x64/loki-rs
ls -la runtime/mac-arm64/loki-rs

# Windows
dir runtime\win-x64\loki-rs.exe
```

## Install Loki-RS (first time on a new drive)

```bash
# Linux / macOS
bash runtime/get-loki.sh

# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File runtime\get-loki.ps1
```

## Basic scan commands

```bash
# Scan a single file
runtime/linux-x64/loki-rs scan /path/to/file.exe

# Scan a directory
runtime/linux-x64/loki-rs scan /home/user/Downloads

# Scan the whole system (slow — do with intent)
runtime/linux-x64/loki-rs scan /

# Scan with verbose output
runtime/linux-x64/loki-rs scan --verbose /path/to/target

# Output results to a log file
runtime/linux-x64/loki-rs scan /target --output /tmp/loki-results.txt
```

On Windows replace `runtime/linux-x64/loki-rs` with `runtime\win-x64\loki-rs.exe`.

## Reading results

Loki-RS outputs findings with severity levels:
- **ALERT** — high confidence malware match. Treat as infected.
- **WARNING** — suspicious match. Investigate further.
- **NOTICE** — low-confidence hit. Likely a false positive but worth checking.

A clean scan ends with: `RESULT: System seems to be CLEAN`

## Install Loki Python (alternative, needs bundled Python)

Loki Python has more features and is actively maintained by Florian Roth.
Requires portable Python to be installed first (`runtime/get-python.sh`).

```bash
# Install Loki Python to tools/loki/
git clone https://github.com/Neo23x0/Loki tools/loki
runtime/linux-x64/python/bin/python3 -m pip install -r tools/loki/requirements.txt

# Run a scan
runtime/linux-x64/python/bin/python3 tools/loki/loki.py --path /target
```

## Update YARA rules

Loki-RS bundles rules but they can go stale. Update periodically:
```bash
runtime/linux-x64/loki-rs update
```

## What to do on a hit

1. Do NOT delete immediately — confirm it's real first
2. Note the file path, hash, and rule that matched
3. Check the hash on VirusTotal manually if uncertain
4. Quarantine: move to a safe folder, don't execute
5. If on a shared machine, inform the owner
