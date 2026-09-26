# Detect local WebView2 Runtime version and download matching msedgedriver.exe
# Installs to $env:USERPROFILE\.cargo\bin\ (same dir as tauri-driver, already on PATH)
#
# 版本来源优先级：WebView2 Runtime → Edge。msedgedriver 驱动的是 WebView2 运行时
# （tauri-driver 以 browserName=webview2 附着），两者版本必须对齐，否则会卡在
# session 建立（见 #255）；本机实测两者通常一致，但 CI 镜像上不保证，故优先取运行时。

$ErrorActionPreference = "Stop"
# Enable TLS 1.2 (PowerShell 5.1 default is SSL3/TLS 1.0)
[Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

# 1. Detect local WebView2 Runtime version（{F3017226-...} 是 WebView2 Runtime 的固定 GUID）
$targetVersion = $null
$versionSource = $null

$webview2Keys = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
)
foreach ($p in $webview2Keys) {
    if (Test-Path $p) {
        $v = (Get-ItemProperty -Path $p -Name "pv" -ErrorAction SilentlyContinue).pv
        if ($v) { $targetVersion = $v; $versionSource = "WebView2 Runtime"; break }
    }
}

# 2. Fallback: Detect local Edge version
if (-not $targetVersion) {
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

    if ($edgeVersion) {
        $targetVersion = $edgeVersion
        $versionSource = "Microsoft Edge"
    }
}

if (-not $targetVersion) {
    Write-Error "Neither WebView2 Runtime nor Microsoft Edge version found. Please install Edge first."
    exit 1
}

Write-Host "[install-msedgedriver] Target version: $targetVersion (source: $versionSource)" -ForegroundColor Cyan

# 3. Download msedgedriver zip
$zipUrl = "https://msedgedriver.microsoft.com/$targetVersion/edgedriver_win64.zip"
$tempZip = "$env:TEMP\msedgedriver-$targetVersion.zip"
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
