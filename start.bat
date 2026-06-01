@echo off
title Audio Nodes
cd /d "%~dp0"

rem ── Audio Nodes launcher ─────────────────────────────────────────────────
rem  Double-click this file to start the app. On the very first run it installs
rem  dependencies automatically; after that it just launches.

where npm >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is required but was not found on this PC.
  echo   Install the LTS version from https://nodejs.org then run this again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo.
  echo   First run - installing dependencies. This can take a minute...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   Dependency install failed. See the messages above.
    echo.
    pause
    exit /b 1
  )
)

echo.
echo   Launching Audio Nodes...
echo   (Close this window to quit the app.)
echo.
call npm run dev
