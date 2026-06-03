<#
  uninstall.ps1 — remove the Audio Nodes Virtual Cable driver package.

  Finds the published package (oemNN.inf) whose original name is
  VirtualAudioDriver.inf and deletes it, removing the endpoints. Run ELEVATED.

  Usage (elevated):  ./uninstall.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltinRole]::Administrator)) {
    throw "Run this from an ELEVATED PowerShell (Run as administrator)."
}

# pnputil /enum-drivers lists published packages; match ours by original name.
# (Class "Media" + Original Name VirtualAudioDriver.inf identifies our package.)
$enum = pnputil /enum-drivers
$published = @()
$current = $null
foreach ($line in $enum) {
    if ($line -match 'Published Name\s*:\s*(oem\d+\.inf)') { $current = $Matches[1] }
    elseif ($line -match 'Original Name\s*:\s*VirtualAudioDriver\.inf' -and $current) {
        $published += $current
        $current = $null
    }
}

if ($published.Count -eq 0) {
    Write-Host "No Audio Nodes Virtual Cable driver package is installed." -ForegroundColor Yellow
    return
}

foreach ($pkg in $published) {
    Write-Host "Removing driver package $pkg ..." -ForegroundColor Cyan
    pnputil /delete-driver $pkg /uninstall /force
}

Write-Host "Removed. The virtual endpoints should no longer appear in Sound settings." -ForegroundColor Green
Write-Host "(The 'Audio Nodes Test' cert in LocalMachine Root/TrustedPublisher can be removed via certlm.msc if desired.)"
