# Detect local WebView2 Runtime version and download matching msedgedriver.exe
# Installs to $env:USERPROFILE\.cargo\bin\ (same dir as tauri-driver, already on PATH)
#
# Version source priority: WebView2 Runtime first, then Microsoft Edge.
# msedgedriver drives the WebView2 *runtime* (tauri-driver attaches with
# browserName=webview2), so the two versions must align or session creation hangs
# (see issue #255). They are usually identical locally, but that is not guaranteed
# on CI images -- hence the runtime is preferred. If a candidate version has no
# published driver (404), the next candidate is tried.
#
# NOTE: keep this file ASCII-only. It is launched with Windows PowerShell 5.1
# (npm script / CI), which decodes BOM-less .ps1 files as ANSI -- non-ASCII
# characters in comments or strings break parsing on Chinese Windows.

$ErrorActionPreference = "Stop"
# Enable TLS 1.2 (PowerShell 5.1 default is SSL3/TLS 1.0)
[Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

# 1. Collect candidate versions: WebView2 Runtime first, Edge as fallback
$candidates = @()

# WebView2 Runtime ({F3017226-...} is its fixed GUID)
$webview2Keys = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
)
foreach ($p in $webview2Keys) {
    if (Test-Path $p) {
        $v = (Get-ItemProperty -Path $p -Name "pv" -ErrorAction SilentlyContinue).pv
        if ($v) {
            $candidates += $v
            Write-Host "[install-msedgedriver] WebView2 Runtime version: $v" -ForegroundColor Cyan
            break
        }
    }
}

# Microsoft Edge
$edgeVersion = $null

$regPaths = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Edge\BLBeacon",
    "HKLM:\SOFTWARE\Microsoft\Edge\BLBeacon",
    "HKCU:\SOFTWARE\Microsoft\Edge\BLBeacon"
)
foreach ($p in $regPaths) {
    if (Test-Path $p) {
        $v = (Get-ItemProperty -Path $p -Name "version" -ErrorAction SilentlyContinue).version
        if ($v) { $edgeVersion = $v; break }
    }
}

if (-not $edgeVersion) {
    $edgeExe = @(
        "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($edgeExe) {
        $vi = (Get-Item $edgeExe).VersionInfo
        $edgeVersion = "$($vi.FileMajorPart).$($vi.FileMinorPart).$($vi.FileBuildPart).$($vi.FilePrivatePart)"
    }
}

if ($edgeVersion -and ($candidates -notcontains $edgeVersion)) {
    $candidates += $edgeVersion
    Write-Host "[install-msedgedriver] Microsoft Edge version: $edgeVersion" -ForegroundColor Cyan
}

if ($candidates.Count -eq 0) {
    Write-Error "Neither WebView2 Runtime nor Microsoft Edge version found. Please install Edge first."
    exit 1
}

$installDir = "$env:USERPROFILE\.cargo\bin"
if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
}

# 2. Try each candidate in order; the first successful download wins
$installed = $false
foreach ($version in $candidates) {
    $zipUrl = "https://msedgedriver.microsoft.com/$version/edgedriver_win64.zip"
    $tempZip = "$env:TEMP\msedgedriver-$version.zip"

    Write-Host "[install-msedgedriver] Downloading: $zipUrl" -ForegroundColor Cyan
    try {
        Invoke-WebRequest -Uri $zipUrl -OutFile $tempZip -UseBasicParsing
    } catch {
        Write-Host "[install-msedgedriver] No driver published for $version, trying next candidate" -ForegroundColor Yellow
        continue
    }

    Write-Host "[install-msedgedriver] Extracting to: $installDir" -ForegroundColor Cyan
    Expand-Archive -Path $tempZip -DestinationPath $installDir -Force
    Remove-Item $tempZip -Force -ErrorAction SilentlyContinue
    $installed = $true
    break
}

$driverPath = Join-Path $installDir "msedgedriver.exe"
if ($installed -and (Test-Path $driverPath)) {
    Write-Host "[install-msedgedriver] Installed: $driverPath" -ForegroundColor Green
    & $driverPath --version
    exit 0
} else {
    Write-Error "msedgedriver.exe not found after extraction"
    exit 1
}
