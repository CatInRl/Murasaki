# Murasaki E2E environment check
# Checks:
#   1. tauri-driver binary on PATH (or via TAURI_DRIVER_PATH)
#   2. msedgedriver.exe (required by tauri-driver on Windows to drive WebView2)
#   3. Built Murasaki.exe at src-tauri/target/release/murasaki.exe
# Any miss will print fix instructions.

$ErrorActionPreference = "Stop"

function Find-Command {
    param([string]$name)
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Test-Binary {
    param([string]$path)
    return [bool](Test-Path $path)
}

$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"

$ok = $true

Write-Host "===== Murasaki E2E Environment Check =====" -ForegroundColor Cyan
Write-Host ""

# 1. tauri-driver
$driver = $env:TAURI_DRIVER_PATH
if (-not $driver) { $driver = Find-Command "tauri-driver" }
if (-not $driver) { $driver = Find-Command "tauri-driver.exe" }
if (-not $driver) {
    # Fallback: check standard cargo bin directory
    $candidate = Join-Path $cargoBin "tauri-driver.exe"
    if (Test-Path $candidate) { $driver = $candidate }
}
if ($driver) {
    Write-Host "[OK]   tauri-driver: $driver" -ForegroundColor Green
} else {
    $ok = $false
    Write-Host "[MISS] tauri-driver not found" -ForegroundColor Red
    Write-Host "       Fix 1: cargo install tauri-driver"
    Write-Host "       Fix 2: download from https://github.com/tauri-apps/tauri-driver/releases"
    Write-Host "              and set TAURI_DRIVER_PATH env var"
}

# 2. msedgedriver (required by tauri-driver on Windows)
$edgeDriver = Find-Command "msedgedriver"
if (-not $edgeDriver) { $edgeDriver = Find-Command "msedgedriver.exe" }
if (-not $edgeDriver) {
    # Fallback: check standard cargo bin directory (install-msedgedriver.ps1 puts it there)
    $candidate = Join-Path $cargoBin "msedgedriver.exe"
    if (Test-Path $candidate) { $edgeDriver = $candidate }
}
if ($edgeDriver) {
    Write-Host "[OK]   msedgedriver: $edgeDriver" -ForegroundColor Green
} else {
    $ok = $false
    Write-Host "[MISS] msedgedriver not found (tauri-driver uses it to drive WebView2 on Windows)" -ForegroundColor Red
    Write-Host "       Fix: run e2e/scripts/install-msedgedriver.ps1"
    Write-Host "       Or download from https://developer.microsoft.com/microsoft-edge/tools/webdriver/"
    Write-Host "            pick the version matching your local Edge runtime"
    Write-Host "            put it on PATH or in $cargoBin"
}

# 3. Murasaki binary
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$appBin = Join-Path $projectRoot "src-tauri\target\release\murasaki.exe"
if ($env:MURASAKI_BINARY) { $appBin = $env:MURASAKI_BINARY }
if (Test-Binary $appBin) {
    Write-Host "[OK]   Murasaki binary: $appBin" -ForegroundColor Green
} else {
    $ok = $false
    Write-Host "[MISS] Murasaki.exe not built" -ForegroundColor Red
    Write-Host "       Fix: npm run tauri:build"
    Write-Host "       Or set MURASAKI_BINARY env var to an existing path"
}

Write-Host ""
if ($ok) {
    Write-Host "===== Environment ready, you can run E2E tests =====" -ForegroundColor Green
    Write-Host "  npm run test:e2e" -ForegroundColor Cyan
    exit 0
} else {
    Write-Host "===== Environment incomplete, fix the missing items above =====" -ForegroundColor Yellow
    exit 1
}
