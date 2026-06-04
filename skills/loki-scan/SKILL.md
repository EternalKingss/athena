---
name: loki-scan
description: Scan files or directories for malware using Loki (YARA + IOC scanner by Florian Roth). Runs off the drive's portable Python — no host install needed.
---

# Loki Malware Scanner

Loki is a YARA + IOC scanner by Florian Roth. It lives in `tools/loki/` and
runs using the drive's portable Python. Nothing is installed on the host.

## Check if Loki is ready

Use `machine_info` — if `bundled.python` is true and `bundled.lokiPy` is true, you're set.

## Install (first time)

```bash
# Linux / macOS — run both once after getting the drive
bash runtime/get-python.sh
bash runtime/get-loki.sh

# Windows
powershell -ExecutionPolicy Bypass -File runtime\get-python.ps1
powershell -ExecutionPolicy Bypass -File runtime\get-loki.ps1
```

Loki clones into `tools/loki/` and its dependencies install into the drive's Python.
On any future machine — just plug in, no setup needed.

## Find the Python path

```bash
# Linux x64
PYTHON=runtime/linux-x64/python/bin/python3

# macOS Apple Silicon
PYTHON=runtime/mac-arm64/python/bin/python3

# Windows
PYTHON=runtime\win-x64\python\python.exe
```

Or let Athena figure it out via `machine_info` bundled paths.

## Scan commands

```bash
# Update signatures first (do this occasionally)
$PYTHON tools/loki/loki.py --update

# Scan a file
$PYTHON tools/loki/loki.py --path /path/to/file.exe

# Scan a directory
$PYTHON tools/loki/loki.py --path /home/user/Downloads

# Scan with a log file
$PYTHON tools/loki/loki.py --path /target --logfile /tmp/loki-scan.log

# Scan the whole system (slow — use with intent)
$PYTHON tools/loki/loki.py --path / --logfile /tmp/loki-full.log
```

## Reading results

- **ALERT** — high confidence malware match. Treat as infected.
- **WARNING** — suspicious. Investigate further.
- **NOTICE** — low confidence, likely false positive but worth a look.

Clean result ends with: `RESULT: System seems to be CLEAN`

## On a hit

1. Don't delete immediately — confirm it's real
2. Note the file path, matched rule, and hash
3. Move to a quarantine folder — don't execute
4. Check the hash on VirusTotal if uncertain
5. If on a shared or someone else's machine, let them know
