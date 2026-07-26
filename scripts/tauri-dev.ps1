# Murasaki dev launcher
# 仅做最小必要的 PATH 修补与 APPDATA 重定向，工具链默认走 MSVC

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

# Rust 工具链：~/.cargo/bin 在交互式 shell 通常已配置，但子进程可能没有
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path $cargoBin) {
    $env:PATH = "$cargoBin;$env:PATH"
}

# 将 APPDATA 重定向到工作区，避免 TRAE Sandbox 阻止应用数据写入
# 注意：仅在 TRAE 环境中需要，但保留此行为以保持一致性
$appdataRoaming = Join-Path $projectRoot ".appdata\Roaming"
$appdataLocal   = Join-Path $projectRoot ".appdata\Local"
New-Item -ItemType Directory -Force -Path $appdataRoaming, $appdataLocal | Out-Null
$env:APPDATA     = $appdataRoaming
$env:LOCALAPPDATA = $appdataLocal

Set-Location $projectRoot
npx tauri dev
exit $LASTEXITCODE
