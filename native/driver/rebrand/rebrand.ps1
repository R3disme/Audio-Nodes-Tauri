<#
  rebrand.ps1 — stamp Audio Nodes branding onto a build copy of the vendored
  upstream driver, without touching the submodule.

  Copies native/driver/vendor/Virtual-Audio-Driver → native/driver/build, then
  rewrites only display strings + the hardware id in VirtualAudioDriver.inx
  (and a couple of cosmetic strings in the .rc). No structural / GUID / service
  changes, so the driver still builds and installs exactly like upstream — it
  just shows up as "Audio Nodes Virtual Cable".

  Called by build.ps1; can also be run standalone.
#>
[CmdletBinding()]
param(
    [string]$Vendor = (Join-Path $PSScriptRoot '..\vendor\Virtual-Audio-Driver'),
    [string]$BuildDir = (Join-Path $PSScriptRoot '..\build'),
    [string]$NamesFile = (Join-Path $PSScriptRoot 'names.psd1')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Vendor)) {
    throw "Upstream not found at $Vendor. Run: git submodule update --init --recursive"
}
$names = Import-PowerShellDataFile -Path $NamesFile

# ── Fresh copy of upstream into build/ ──────────────────────────────────────
if (Test-Path $BuildDir) { Remove-Item -Recurse -Force $BuildDir }
Write-Host "Copying upstream → $BuildDir ..." -ForegroundColor Cyan
Copy-Item -Recurse -Force $Vendor $BuildDir
# Drop the submodule's own .git so it isn't mistaken for a nested repo.
$dotGit = Join-Path $BuildDir '.git'
if (Test-Path $dotGit) { Remove-Item -Recurse -Force $dotGit }

# ── Helpers (the .inx is UTF-16LE) ──────────────────────────────────────────
function Edit-Utf16([string]$Path, [scriptblock]$Transform) {
    $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::Unicode)
    $text = & $Transform $text
    [System.IO.File]::WriteAllText($Path, $text, [System.Text.Encoding]::Unicode)
}

# Replace the value of a `Key = "..."` line (any whitespace), preserving the key
# and the line's CRLF (match value chars only, not the line terminator).
function Set-InxString([string]$text, [string]$key, [string]$value) {
    $pattern = '(?m)^(\s*' + [regex]::Escape($key) + '\s*=\s*)[^\r\n]*'
    return [regex]::Replace($text, $pattern, ('${1}"' + $value + '"'))
}

# ── INX: device + endpoint friendly names, provider, hardware id ────────────
$inx = Join-Path $BuildDir 'Source\Main\VirtualAudioDriver.inx'
if (-not (Test-Path $inx)) { throw "INX not found: $inx" }

$map = @{
    'ProviderName'                              = $names.Provider
    'MfgName'                                   = $names.Provider
    'MsCopyRight'                               = $names.Provider
    'VIRTUALAUDIODRIVER_SA.DeviceDesc'          = $names.DeviceDesc
    'VirtualAudioDriver.SvcDesc'                = $names.DeviceDesc
    'VIRTUALAUDIODRIVER.WaveSpeaker.szPname'    = $names.PlaybackName
    'VIRTUALAUDIODRIVER.TopologySpeaker.szPname' = $names.PlaybackName
    'VIRTUALAUDIODRIVER.WaveMicArray1.szPname'  = $names.RecordingName
    'VIRTUALAUDIODRIVER.TopologyMicArray1.szPname' = $names.RecordingName
    'MicArray1CustomName'                       = $names.RecordingName
}

Edit-Utf16 $inx {
    param($t)
    foreach ($k in $map.Keys) { $t = Set-InxString $t $k $map[$k] }
    # Distinct PnP hardware id so we don't collide with an upstream install.
    # (-replace replacement strings treat backslashes literally; only $ is special.)
    $t = $t -replace [regex]::Escape('ROOT\VirtualAudioDriver'), $names.HardwareId
    return $t
}
Write-Host "Rebranded $inx" -ForegroundColor Green

# ── RC: cosmetic file-version strings (best-effort) ─────────────────────────
$rc = Join-Path $BuildDir 'Source\Main\VirtualAudioDriver.rc'
if (Test-Path $rc) {
    # The .rc is typically UTF-16 too; handle both.
    try {
        Edit-Utf16 $rc {
            param($t)
            $t = $t -replace 'Virtual Audio Driver by MTT', $names.DeviceDesc
            $t = $t -replace 'MikeTheTech', $names.Provider
            return $t
        }
        Write-Host "Rebranded $rc" -ForegroundColor Green
    } catch {
        Write-Warning "Skipped .rc rebrand (non-fatal): $($_.Exception.Message)"
    }
}

Write-Host "Rebrand complete → $BuildDir" -ForegroundColor Cyan
