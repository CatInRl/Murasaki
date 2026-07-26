<#
.SYNOPSIS
    Murasaki 开发环境一键检测与配置脚本

.DESCRIPTION
    本脚本检测本地开发环境是否满足 Murasaki 构建要求，并在缺失时给出明确的修复指引。
    - 检测 Node.js / npm
    - 检测 Rust 工具链（默认 stable-x86_64-pc-windows-msvc）
    - 检测 Visual Studio Build Tools 2022 + VC++ 工作负载
    - 检测项目依赖是否已安装

.PARAMETER InstallMissing
    如果指定此开关，缺失的组件将尝试自动安装（需要管理员权限 / winget）

.EXAMPLE
    # 仅检测
    .\scripts\setup-env.ps1

.EXAMPLE
    # 检测并自动安装缺失组件
    .\scripts\setup-env.ps1 -InstallMissing
#>
[CmdletBinding()]
param(
    [switch]$InstallMissing
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$issues = @()

function Write-Section($name) {
    Write-Host "`n=== $name ===" -ForegroundColor Cyan
}

function Write-Ok($msg) {
    Write-Host "  [OK] $msg" -ForegroundColor Green
}

function Write-Warn($msg) {
    Write-Host "  [!!] $msg" -ForegroundColor Yellow
    $script:issues += $msg
}

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# ===================================================================
# 1. Node.js
# ===================================================================
Write-Section "Node.js"
if (Test-Command node) {
    $nodeVer = node --version
    Write-Ok "Node.js $nodeVer"
} else {
    Write-Warn "Node.js 未安装"
    if ($InstallMissing) {
        Write-Host "  正在通过 winget 安装 Node.js..." -ForegroundColor Cyan
        winget install --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
        $env:PATH = "$env:ProgramFiles\nodejs;$env:PATH"
    }
}

if (Test-Command npm) {
    $npmVer = npm --version
    Write-Ok "npm $npmVer"
} else {
    Write-Warn "npm 未安装（应随 Node.js 一起安装）"
}

# ===================================================================
# 2. Rust 工具链
# ===================================================================
Write-Section "Rust 工具链"
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path $cargoBin) {
    $env:PATH = "$cargoBin;$env:PATH"
}

if (Test-Command rustup) {
    $defaultToolchain = (rustup show 2>&1 | Select-String "stable-x86_64-pc-windows-(msvc|gnu)").ToString().Trim()
    if ($defaultToolchain -match "msvc") {
        Write-Ok "Rust 默认工具链: $defaultToolchain"
    } else {
        Write-Warn "Rust 默认工具链是 $defaultToolchain，应为 stable-x86_64-pc-windows-msvc"
        if ($InstallMissing) {
            Write-Host "  正在切换到 MSVC..." -ForegroundColor Cyan
            rustup default stable-x86_64-pc-windows-msvc
            Write-Ok "已切换到 MSVC"
        }
    }
} else {
    Write-Warn "Rust 未安装"
    if ($InstallMissing) {
        Write-Host "  正在通过 winget 安装 Rustup..." -ForegroundColor Cyan
        winget install --id Rustlang.Rustup --accept-package-agreements --accept-source-agreements
        $env:PATH = "$cargoBin;$env:PATH"
        rustup default stable-x86_64-pc-windows-msvc
    }
}

# ===================================================================
# 3. Visual Studio Build Tools (MSVC C++)
# ===================================================================
Write-Section "Visual Studio Build Tools"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vsInstalled = $false
if (Test-Path $vswhere) {
    $vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if ($vsPath) {
        $vsName = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property displayName 2>$null
        Write-Ok "$vsName"
        Write-Ok "路径: $vsPath"
        $vsInstalled = $true
    }
}

if (-not $vsInstalled) {
    Write-Warn "未检测到 Visual Studio Build Tools 2022 + VC++ 工作负载"
    if ($InstallMissing) {
        Write-Host "  正在通过 winget 安装 VS 2022 Build Tools + VC++ 工作负载..." -ForegroundColor Cyan
        Write-Host "  这可能需要 10-30 分钟，取决于网络速度..." -ForegroundColor Cyan
        winget install --id Microsoft.VisualStudio.2022.BuildTools `
            --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" `
            --accept-package-agreements --accept-source-agreements
    }
}

# ===================================================================
# 4. 项目 npm 依赖
# ===================================================================
Write-Section "项目 npm 依赖"
if (Test-Path "node_modules") {
    Write-Ok "node_modules 已存在"
} else {
    Write-Warn "node_modules 不存在，需要运行 'npm install'"
    if ($InstallMissing) {
        Write-Host "  正在安装 npm 依赖..." -ForegroundColor Cyan
        npm install
    }
}

# ===================================================================
# 5. 验证 cargo 可用
# ===================================================================
Write-Section "Cargo 验证"
if (Test-Command cargo) {
    $cargoVer = cargo --version
    Write-Ok $cargoVer
} else {
    Write-Warn "cargo 不可用（检查 PATH 是否包含 ~/.cargo/bin）"
}

# ===================================================================
# 总结
# ===================================================================
Write-Host "`n=== 检测总结 ===" -ForegroundColor Cyan
if ($issues.Count -eq 0) {
    Write-Host "  环境就绪，可以运行 'npm run tauri:dev'" -ForegroundColor Green
    exit 0
} else {
    Write-Host "  发现 $($issues.Count) 个问题：" -ForegroundColor Yellow
    $issues | ForEach-Object { Write-Host "    - $_" -ForegroundColor Yellow }
    if (-not $InstallMissing) {
        Write-Host "`n  提示：运行 'scripts\setup-env.ps1 -InstallMissing' 自动修复" -ForegroundColor Cyan
    }
    exit 1
}
