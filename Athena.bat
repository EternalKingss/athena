@echo off
setlocal
set "ROOT=%~dp0"
set "ARCH=win-x64"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=win-arm64"
set "NODE=%ROOT%runtime\%ARCH%\node.exe"
if not exist "%NODE%" (
  echo.
  echo   Portable Node not found at: %NODE%
  echo   See README.md - drop the Windows Node build into runtime\%ARCH%\
  echo.
  pause
  exit /b 1
)
"%NODE%" --no-warnings "%ROOT%athena\athena.mjs" --ui
pause
