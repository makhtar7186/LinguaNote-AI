# Builds the Windows installer: frozen Python service + FFmpeg + Electron application.
#
#   powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1 [-FfmpegPath C:\path\to\ffmpeg.exe] [-SkipService]
#
# Prerequisites: services\transcription\.venv installed from requirements-lock.txt, npm ci done, FFmpeg available.
# Output: release\ (installer) and release\win-unpacked\ (the installed files, used by the packaged smoke test).
param(
    [string] $FfmpegPath = "",
    [switch] $SkipService
)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$serviceDir = Join-Path $root "services\transcription"
$python = Join-Path $serviceDir ".venv\Scripts\python.exe"
$distDir = Join-Path $serviceDir "dist"

function Invoke-Step([string] $label, [scriptblock] $action) {
    Write-Output "==> $label"
    & $action
    if ($LASTEXITCODE -ne 0) { throw "Step failed ($LASTEXITCODE): $label" }
}

if (-not (Test-Path $python)) { throw "Missing $python. Install the service first (see README)." }

# FFmpeg: an explicit choice, then LINGUANOTE_FFMPEG, then the PATH. Never downloaded behind the builder's back.
if (-not $FfmpegPath) { $FfmpegPath = $env:LINGUANOTE_FFMPEG }
if (-not $FfmpegPath) { $FfmpegPath = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source }
if (-not $FfmpegPath -or -not (Test-Path $FfmpegPath)) { throw "FFmpeg not found. Pass -FfmpegPath." }
# The FFmpeg licence must travel with the binary: refuse to ship one without it.
$ffmpegLicense = Join-Path (Split-Path -Parent (Split-Path -Parent $FfmpegPath)) "LICENSE"
if (-not (Test-Path $ffmpegLicense)) { throw "No LICENSE next to $FfmpegPath (expected $ffmpegLicense). It must be shipped with FFmpeg." }

if (-not $SkipService) {
    Invoke-Step "Installing the packaging tool" {
        Push-Location $serviceDir
        try { & $python -m pip install --quiet --disable-pip-version-check -e ".[package]" }
        finally { Pop-Location }
    }
    Invoke-Step "Freezing the service (PyInstaller)" {
        Push-Location $serviceDir
        try {
            & $python -m PyInstaller --noconfirm --clean --log-level WARN `
                --distpath $distDir --workpath (Join-Path $distDir "pyinstaller-work") `
                (Join-Path $serviceDir "packaging\linguanote-service.spec")
        }
        finally { Pop-Location }
    }
}
if (-not (Test-Path (Join-Path $distDir "linguanote-service\linguanote-service.exe"))) {
    throw "The frozen service is missing: run again without -SkipService."
}

Write-Output "==> Staging FFmpeg ($FfmpegPath)"
$ffmpegStage = Join-Path $distDir "ffmpeg"
New-Item -ItemType Directory -Force $ffmpegStage | Out-Null
Copy-Item -Force $FfmpegPath (Join-Path $ffmpegStage "ffmpeg.exe")
Copy-Item -Force $ffmpegLicense (Join-Path $ffmpegStage "LICENSE-ffmpeg.txt")

# Electron must not inherit this variable from an editor built on Electron (see start-electron.cjs).
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

Push-Location $root
try {
    Invoke-Step "Building the pages" { npm run build }
    Invoke-Step "Building the installer (electron-builder)" { npm run package:installer --workspace apps/desktop }
}
finally { Pop-Location }

Write-Output "Done. Installer: $(Join-Path $root 'release')"
Get-ChildItem (Join-Path $root "release") -Filter *.exe | ForEach-Object { Write-Output ("  {0} ({1:N0} Mo)" -f $_.Name, ($_.Length / 1MB)) }
