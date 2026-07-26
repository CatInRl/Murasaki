# Murasaki production build launcher

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path $cargoBin) {
    $env:PATH = "$cargoBin;$env:PATH"
}

# 生产构建仍需重定向 APPDATA，与 dev 保持一致
$appdataRoaming = Join-Path $projectRoot ".appdata\Roaming"
$appdataLocal   = Join-Path $projectRoot ".appdata\Local"
New-Item -ItemType Directory -Force -Path $appdataRoaming, $appdataLocal | Out-Null
$env:APPDATA     = $appdataRoaming
$env:LOCALAPPDATA = $appdataLocal

Set-Location $projectRoot
npx tauri build
exit $LASTEXITCODE
