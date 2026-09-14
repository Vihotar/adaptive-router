@echo off
setlocal

set "PORT=3210"
set "STATUS_URL=http://127.0.0.1:%PORT%/api/status"
set "FALLBACK_STATUS_URL=http://localhost:%PORT%/api/status"
set "DASHBOARD_URL=http://localhost:%PORT%"
set "PROJECT_DIR=C:\projects\adaptive-router\AI Projects\Adaptive Router"

:: 1. Check whether Adaptive Router is already responding
curl.exe -s -o NUL --connect-timeout 2 "%STATUS_URL%"
if %ERRORLEVEL% EQU 0 (
    start "" "%DASHBOARD_URL%"
    exit /b 0
)
curl.exe -s -o NUL --connect-timeout 2 "%FALLBACK_STATUS_URL%"
if %ERRORLEVEL% EQU 0 (
    start "" "%DASHBOARD_URL%"
    exit /b 0
)

:: 2. Locate node executable
set "NODE_CMD=node"
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    if exist "C:\Program Files\nodejs\node.exe" (
        set "NODE_CMD=C:\Program Files\nodejs\node.exe"
    )
)

:: 3. If not running, switch to project directory and start Adaptive Router minimized
cd /d "%PROJECT_DIR%"
start "" /min "%NODE_CMD%" router.mjs dashboard --port %PORT%

:: 4. Poll until AR responds (up to 20 seconds using ping delay)
set "MAX_TRIES=20"
set "TRY_COUNT=0"

:poll_loop
ping -n 2 127.0.0.1 >nul
curl.exe -s -o NUL --connect-timeout 2 "%STATUS_URL%"
if %ERRORLEVEL% EQU 0 goto :open_browser
curl.exe -s -o NUL --connect-timeout 2 "%FALLBACK_STATUS_URL%"
if %ERRORLEVEL% EQU 0 goto :open_browser

set /a TRY_COUNT+=1
if %TRY_COUNT% LSS %MAX_TRIES% (
    goto :poll_loop
)

:: 5. If failed to respond after timeout
echo Adaptive Router failed to start on port %PORT%.
pause
exit /b 1

:open_browser
start "" "%DASHBOARD_URL%"
exit /b 0
