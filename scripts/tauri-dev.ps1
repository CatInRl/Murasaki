# Murasaki dev launcher
# Sets up Rust + MinGW PATH and redirects APPDATA to bypass sandbox

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

# Rust toolchain
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

# MinGW (WinLibs) - provides dlltool/ld for GNU toolchain
$mingwBin = "C:\Users\nail1\AppData\Local\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin"
if (Test-Path $mingwBin) {
    $env:PATH = "$mingwBin;$env:PATH"
} else {
    Write-Warning "MinGW bin not found: $mingwBin"
}

# Redirect APPDATA into workspace to avoid TRAE sandbox blocking app data writes
$appdataRoaming = Join-Path $projectRoot ".appdata\Roaming"
$appdataLocal   = Join-Path $projectRoot ".appdata\Local"
New-Item -ItemType Directory -Force -Path $appdataRoaming, $appdataLocal | Out-Null
$env:APPDATA     = $appdataRoaming
$env:LOCALAPPDATA = $appdataLocal

# Launch tauri dev
Set-Location $projectRoot
npx tauri dev
exit $LASTEXITCODE
