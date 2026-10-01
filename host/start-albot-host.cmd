@echo off
setlocal
cd /d "%~dp0.."
echo [AL Bot] Starting local SSD host on 127.0.0.1:17391
echo [AL Bot] Account state: D:\ALBot\state
echo [AL Bot] Telemetry:     D:\ALBot\telemetry
node host\telemetry-recorder.mjs
if errorlevel 1 (
  echo.
  echo [AL Bot] Host stopped with an error. Verify that Node.js is installed and available in PATH.
  pause
)
