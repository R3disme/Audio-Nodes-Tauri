# ── Audio Nodes launcher (PowerShell) ───────────────────────────────────────
#  Right-click → "Run with PowerShell", or run:  ./start.ps1
#  Installs dependencies on first run, then launches the app.

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host ''
  Write-Host '  Node.js is required but was not found.' -ForegroundColor Yellow
  Write-Host '  Install the LTS version from https://nodejs.org then run this again.'
  Write-Host ''
  Read-Host 'Press Enter to exit'
  exit 1
}

if (-not (Test-Path 'node_modules')) {
  Write-Host ''
  Write-Host '  First run - installing dependencies. This can take a minute...' -ForegroundColor Cyan
  Write-Host ''
  npm install
}

Write-Host ''
Write-Host '  Launching Audio Nodes...' -ForegroundColor Green
Write-Host ''
npm run dev
