<#
  install.ps1 — trust the test cert + install the Audio Nodes Virtual Cable.

  Run ELEVATED. Expects build.ps1 to have produced native/driver/out/ with the
  signed VirtualAudioDriver.{sys,inf,cat} + AudioNodesTest.cer. Requires test
  signing on (bcdedit /set testsigning on; reboot) for a test-signed driver.

  Usage (elevated):
    ./install.ps1                 # uses native/driver/out
    ./install.ps1 -OutDir <path>
#>
[CmdletBinding()]
param(
    [string]$OutDir = (Join-Path $PSScriptRoot 'out')
)

$ErrorActionPreference = 'Stop'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltinRole]::Administrator)) {
    throw "Run this from an ELEVATED PowerShell (Run as administrator)."
}

$inf = Join-Path $OutDir 'VirtualAudioDriver.inf'
$cer = Join-Path $OutDir 'AudioNodesTest.cer'
if (-not (Test-Path $inf)) { throw "INF not found: $inf  (run ./build.ps1 first)" }

# Warn if test signing is off — a test-signed driver won't load otherwise.
if (-not ((bcdedit /enum '{current}' | Select-String -SimpleMatch 'testsigning') -match 'Yes')) {
    Write-Warning "Test signing appears OFF — the driver will not load."
    Write-Warning "Enable with:  bcdedit /set testsigning on   (then reboot), and re-run."
}

# Trust our test cert so Windows accepts the signature (Root + TrustedPublisher).
if (Test-Path $cer) {
    Write-Host "Trusting test certificate ..." -ForegroundColor Cyan
    Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
    Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null
} else {
    Write-Warning "Cert $cer not found — install may fail if the signature isn't already trusted."
}

Write-Host "Installing driver package: $inf" -ForegroundColor Cyan
# /add-driver … /install adds the package to the driver store AND installs it,
# creating the root-enumerated device for our INF.
pnputil /add-driver $inf /install

Write-Host "`nDone. Check Settings > System > Sound for:" -ForegroundColor Green
Write-Host "  - Audio Nodes Virtual Cable (Playback)   [other apps play here]"
Write-Host "  - Audio Nodes Virtual Cable (Recording)  [Audio Nodes / apps record here]"
