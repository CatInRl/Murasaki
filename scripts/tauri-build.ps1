# Murasaki production build launcher

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

$mingwBin = "C:\Users\nail1\AppData\Local\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin"
if (Test-Path $mingwBin) {
    $env:PATH = "$mingwBin;$env:PATH"
}

$appdataRoaming = Join-Path $projectRoot ".appdata\Roaming"
$appdataLocal   = Join-Path $projectRoot ".appdata\Local"
New-Item -ItemType Directory -Force -Path $appdataRoaming, $appdataLocal | Out-Null
$env:APPDATA     = $appdataRoaming
$env:LOCALAPPDATA = $appdataLocal

Set-Location $projectRoot
npx tauri build
exit $LASTEXITCODE
