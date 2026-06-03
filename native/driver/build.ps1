<#
  build.ps1 — build + test-sign the Audio Nodes Virtual Cable driver.

  Pipeline:
    1. ensure the upstream submodule is present
    2. rebrand a build copy  (rebrand/rebrand.ps1)
    3. msbuild the .sln       (WDK; x64 Release)
    4. ensure a local code-signing test cert exists
    5. Inf2Cat + signtool     (test-sign the .sys and .cat)
    6. stage the package      → native/driver/out/

  Prerequisites: Visual Studio 2022 (Desktop C++) + the Windows Driver Kit (WDK).
  No admin needed for build/sign (signs with a CurrentUser cert). Trusting the
  cert + installing happens in install.ps1 (elevated).

  Usage:
    ./build.ps1                       # Release x64
    ./build.ps1 -Configuration Debug
#>
[CmdletBinding()]
param(
    [ValidateSet('Release', 'Debug')] [string]$Configuration = 'Release',
    [ValidateSet('x64', 'ARM64')]     [string]$Platform = 'x64',
    [switch]$SkipBuild   # only rebrand + sign an existing build (for iterating on signing)
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$vendor = Join-Path $root 'vendor\Virtual-Audio-Driver'
$buildDir = Join-Path $root 'build'
$outDir = Join-Path $root 'out'
$names = Import-PowerShellDataFile -Path (Join-Path $root 'rebrand\names.psd1')

# ── Tool discovery ──────────────────────────────────────────────────────────
function Find-MsBuild {
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vswhere) {
        $p = & $vswhere -latest -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1
        if ($p) { return $p }
    }
    $cmd = Get-Command msbuild -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw "MSBuild not found. Install Visual Studio 2022 (Desktop C++) + WDK."
}

# Newest x64 build tool from the Windows Kits, by name (signtool.exe / inf2cat.exe).
function Find-KitTool([string]$name) {
    $bin = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
    if (-not (Test-Path $bin)) { throw "Windows Kits bin not found — is the WDK/SDK installed?" }
    $hit = Get-ChildItem -Path $bin -Recurse -Filter $name -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\' } |
        Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $hit) { throw "$name not found under $bin (install the WDK)." }
    return $hit.FullName
}

# ── 1. Ensure submodule ─────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $vendor 'VirtualAudioDriver.sln'))) {
    Write-Host "Fetching upstream submodule ..." -ForegroundColor Cyan
    git -C $root submodule update --init --recursive
    if (-not (Test-Path (Join-Path $vendor 'VirtualAudioDriver.sln'))) {
        throw "Upstream submodule missing at $vendor"
    }
}

# ── 2. Rebrand into build/ ──────────────────────────────────────────────────
& (Join-Path $root 'rebrand\rebrand.ps1') -Vendor $vendor -BuildDir $buildDir

$sln = Join-Path $buildDir 'VirtualAudioDriver.sln'
$pkgDir = Join-Path $buildDir "$Platform\$Configuration\package"

# ── 3. Build ────────────────────────────────────────────────────────────────
if (-not $SkipBuild) {
    $msbuild = Find-MsBuild
    Write-Host "Building with $msbuild ($Configuration|$Platform) ..." -ForegroundColor Cyan
    & $msbuild $sln /p:Configuration=$Configuration /p:Platform=$Platform /nologo /verbosity:minimal
    if ($LASTEXITCODE -ne 0) { throw "msbuild failed ($LASTEXITCODE)." }
}
if (-not (Test-Path $pkgDir)) { throw "Package dir not produced: $pkgDir" }

$sys = Join-Path $pkgDir 'VirtualAudioDriver.sys'
$inf = Join-Path $pkgDir 'VirtualAudioDriver.inf'
$cat = Join-Path $pkgDir 'virtualaudiodriver.cat'
if (-not (Test-Path $sys)) { throw "Driver binary missing: $sys" }

# ── 4. Test cert (CurrentUser\My) ───────────────────────────────────────────
$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq "CN=$($names.TestCertName)" } | Select-Object -First 1
if (-not $cert) {
    Write-Host "Creating self-signed code-signing cert 'CN=$($names.TestCertName)' ..." -ForegroundColor Cyan
    $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=$($names.TestCertName)" `
        -CertStoreLocation Cert:\CurrentUser\My -KeyUsage DigitalSignature `
        -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(5)
}

# ── 5. Sign: .sys, (re)build .cat with Inf2Cat, sign .cat ───────────────────
$signtool = Find-KitTool 'signtool.exe'
$inf2cat = Find-KitTool 'inf2cat.exe'
$ts = 'http://timestamp.digicert.com'
$thumb = $cert.Thumbprint

Write-Host "Signing $([System.IO.Path]::GetFileName($sys)) ..." -ForegroundColor Cyan
& $signtool sign /fd sha256 /sha1 $thumb /tr $ts /td sha256 $sys
if ($LASTEXITCODE -ne 0) { throw "signtool (.sys) failed." }

Write-Host "Inf2Cat ($pkgDir) ..." -ForegroundColor Cyan
& $inf2cat /driver:$pkgDir /os:10_X64 /verbose
if ($LASTEXITCODE -ne 0) { throw "Inf2Cat failed (check the INF)." }

Write-Host "Signing catalog ..." -ForegroundColor Cyan
& $signtool sign /fd sha256 /sha1 $thumb /tr $ts /td sha256 $cat
if ($LASTEXITCODE -ne 0) { throw "signtool (.cat) failed." }

# ── 6. Stage out/ ───────────────────────────────────────────────────────────
if (Test-Path $outDir) { Remove-Item -Recurse -Force $outDir }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Copy-Item "$pkgDir\*" $outDir -Force
# Export the public cert so install.ps1 can trust it (elevated).
Export-Certificate -Cert $cert -FilePath (Join-Path $outDir 'AudioNodesTest.cer') | Out-Null

Write-Host "`nDone → $outDir" -ForegroundColor Green
Get-ChildItem $outDir | Select-Object Name, Length | Format-Table -AutoSize
Write-Host "Next:" -ForegroundColor Yellow
Write-Host "  1) Enable test signing (one-time, reboots):  bcdedit /set testsigning on"
Write-Host "  2) Install (elevated):  ./install.ps1"
