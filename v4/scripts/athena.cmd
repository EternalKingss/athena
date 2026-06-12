@echo off
REM Athena launcher wrapper -- forwards to athena.ps1 next to this file.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0athena.ps1" %*
