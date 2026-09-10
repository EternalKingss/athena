@echo off
setlocal enabledelayedexpansion
set "ROOT=%~dp0"

:: --- Request admin rights ---
net session >nul 2>&1
if %errorLevel% neq 0 (
  echo Athena needs administrator rights. Relaunching as admin...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

:: --- Find active network interface ---
set "IFACE="
for /f "tokens=4 delims= " %%i in ('netsh interface show interface ^| findstr /i "Connected"') do (
  if not defined IFACE set "IFACE=%%i"
)
if not defined IFACE (
  echo   [dns] Could not detect active network interface — skipping DNS setup
  goto launch
)

:: --- Save current DNS then apply AdGuard ---
set "BACKUP=%ROOT%data\.dns_backup_win.txt"
netsh interface ip show dns "%IFACE%" > "%BACKUP%" 2>nul
netsh interface ip set dns "%IFACE%" static 94.140.14.14 primary >nul 2>&1
netsh interface ip add dns "%IFACE%" 94.140.15.15 index=2 >nul 2>&1
echo   [dns] AdGuard DNS active — ad blocking on (%IFACE%)

:launch
set "ARCH=win-x64"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=win-arm64"
set "NODE=%ROOT%runtime\%ARCH%\node.exe"
if not exist "%NODE%" (
  echo.
  echo   Node not found at: %NODE%
  echo   Drop the Windows Node build into runtime\%ARCH%\
  echo.
  pause
  exit /b 1
)
"%NODE%" --no-warnings "%ROOT%athena\athena.mjs" --ui

:: --- Restore DNS after Athena exits ---
if defined IFACE (
  netsh interface ip set dns "%IFACE%" dhcp >nul 2>&1
  del "%BACKUP%" >nul 2>&1
  echo   [dns] DNS restored
)

pause
