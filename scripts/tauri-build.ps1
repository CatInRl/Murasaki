# Murasaki production build launcher

$ErrorActionPreference = "Stop"
# $PSScriptRoot 在某些调用方式（如 npm 包装的 powershell -File）下可能为空，做兜底
if ($PSScriptRoot) {
    $scriptDir = $PSScriptRoot
} elseif ($PSCommandPath) {
    $scriptDir = Split-Path $PSCommandPath -Parent
} elseif ($MyInvocation.MyCommand.Path) {
    $scriptDir = Split-Path $MyInvocation.MyCommand.Path -Parent
} else {
    $scriptDir = $PWD.Path
}
$projectRoot = Split-Path -Parent $scriptDir
Write-Host "[tauri-build] projectRoot = $projectRoot"

$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path $cargoBin) {
    $env:PATH = "$cargoBin;$env:PATH"
}

# 生产构建仍需重定向 APPDATA，与 dev 保持一致
# 注意：TRAE 的 safe_rm_aliases.ps1 会 hook Join-Path，导致某些情况返回空字符串
# 因此这里直接用字符串拼接
$appdataRoot   = "$projectRoot\.appdata"
$appdataRoaming = "$appdataRoot\Roaming"
$appdataLocal   = "$appdataRoot\Local"
Write-Host "[tauri-build] appdataRoaming = $appdataRoaming"
Write-Host "[tauri-build] appdataLocal   = $appdataLocal"
if (-not (Test-Path $appdataRoaming)) { [System.IO.Directory]::CreateDirectory($appdataRoaming) | Out-Null }
if (-not (Test-Path $appdataLocal))   { [System.IO.Directory]::CreateDirectory($appdataLocal)   | Out-Null }
$env:APPDATA     = $appdataRoaming
$env:LOCALAPPDATA = $appdataLocal

Set-Location $projectRoot
npx tauri build
exit $LASTEXITCODE
