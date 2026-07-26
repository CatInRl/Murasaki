# Detect local Edge version and download matching msedgedriver.exe
# Installs to $env:USERPROFILE\.cargo\bin\ (same dir as tauri-driver, already on PATH)

$ErrorActionPreference = "Stop"
# Enable TLS 1.2 (PowerShell 5.1 default is SSL3/TLS 1.0)
[Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

# 1. Detect local Edge version
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

if (-not $edgeVersion) {
    Write-Error "Local Microsoft Edge not found. Please install Edge first."
    exit 1
}

Write-Host "[install-msedgedriver] Local Edge version: $edgeVersion" -ForegroundColor Cyan

# 2. Download msedgedriver zip
$zipUrl = "https://msedgedriver.microsoft.com/$edgeVersion/edgedriver_win64.zip"
$tempZip = "$env:TEMP\msedgedriver-$edgeVersion.zip"
$installDir = "$env:USERPROFILE\.cargo\bin"

if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
}

Write-Host "[install-msedgedriver] Downloading: $zipUrl" -ForegroundColor Cyan
try {
    Invoke-WebRequest -Uri $zipUrl -OutFile $tempZip -UseBasicParsing
} catch {
    Write-Error "Download failed: $_"
    exit 1
}

Write-Host "[install-msedgedriver] Extracting to: $installDir" -ForegroundColor Cyan
Expand-Archive -Path $tempZip -DestinationPath $installDir -Force

Remove-Item $tempZip -Force -ErrorAction SilentlyContinue

$driverPath = Join-Path $installDir "msedgedriver.exe"
if (Test-Path $driverPath) {
    Write-Host "[install-msedgedriver] Installed: $driverPath" -ForegroundColor Green
    & $driverPath --version
    exit 0
} else {
    Write-Error "msedgedriver.exe not found after extraction"
    exit 1
}
