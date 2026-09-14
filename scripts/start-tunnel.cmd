@echo off
REM ─────────────────────────────────────────────────────────────────────────────
REM  Adaptive Router — ChatGPT Connector Tunnel Startup
REM
REM  This script:
REM    1. Checks that cloudflared is installed (or offers instructions)
REM    2. Shows your connector token (copy this once into ChatGPT settings)
REM    3. Starts the Cloudflare Quick Tunnel
REM    4. Displays the HTTPS URL to paste into ChatGPT connector settings
REM
REM  Run this once per session when you want ChatGPT to read Adaptive Router.
REM  The Adaptive Router dashboard (npm run dashboard) must already be running.
REM ─────────────────────────────────────────────────────────────────────────────

echo.
echo  ============================================================
echo   Adaptive Router — ChatGPT Connector Setup
echo  ============================================================
echo.

REM Check dashboard is running
curl -s http://localhost:3210/api/status >nul 2>&1
if errorlevel 1 (
  echo  [!] Adaptive Router dashboard is NOT running.
  echo      Start it first with:  npm run dashboard
  echo      Then run this script again.
  pause
  exit /b 1
)
echo  [OK] Adaptive Router dashboard is running on port 3210.
echo.

REM Show connector token
echo  Your ChatGPT connector token:
echo  ─────────────────────────────
curl -s http://localhost:3210/api/connector/token
echo.
echo  ─────────────────────────────
echo.
echo  Copy the token above. You will paste it into ChatGPT connector
echo  settings as the Bearer Token (one-time setup — see CHATGPT-SETUP.md).
echo.

REM Check cloudflared is available
where cloudflared >nul 2>&1
if errorlevel 1 (
  echo  [!] cloudflared is not installed.
  echo.
  echo  Install it from: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
  echo.
  echo  Windows quick install (requires winget):
  echo    winget install --id Cloudflare.cloudflared
  echo.
  echo  After installing, run this script again.
  pause
  exit /b 1
)
echo  [OK] cloudflared found.
echo.
echo  ============================================================
echo   Starting secure tunnel...
echo   The HTTPS URL will appear below in a moment.
echo   Copy it and paste it into ChatGPT connector settings.
echo  ============================================================
echo.

cloudflared tunnel --url http://localhost:3210
