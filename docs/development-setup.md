# 开发环境配置指南

本文档记录 Murasaki 项目在 Windows 上的开发环境配置要求与常见问题排查。
**新会话或新克隆机器必须先阅读本文档**，避免重复踩坑。

## 一键环境检测

```powershell
# 仅检测（不会修改任何东西）
npm run setup

# 检测并自动安装缺失组件（需要管理员权限）
npm run setup:install
```

## 环境要求

| 组件 | 版本要求 | 用途 |
|---|---|---|
| Node.js | ≥ 18 LTS | 前端构建 |
| npm | ≥ 9 | 依赖管理 |
| Rust stable | 最新稳定版 | 后端编译 |
| Rust 工具链 | `stable-x86_64-pc-windows-msvc` | **必须** MSVC，不要用 GNU |
| Visual Studio Build Tools 2022 | 17.x | MSVC C++ 编译器 + Windows SDK |

### 为什么必须用 MSVC 而非 GNU？

Tauri 官方推荐 MSVC 工具链。GNU 工具链会引入一系列问题：
- 需要 MinGW (WinLibs)，安装路径长且机器特定
- 链接器警告 `multiple-definition`，需要 rustflag workaround
- 各机器配置不一致，新会话难以复现

**结论：统一使用 MSVC，避免所有 GNU 相关问题。**

## 手动安装步骤（如果一键脚本失败）

### 1. 安装 Node.js

```powershell
winget install --id OpenJS.NodeJS.LTS
```

### 2. 安装 Rust

```powershell
winget install --id Rustlang.Rustup
# 关闭并重开终端后
rustup default stable-x86_64-pc-windows-msvc
```

### 3. 安装 Visual Studio Build Tools

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools `
    --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" `
    --accept-package-agreements --accept-source-agreements
```

需要 5-10 GB 磁盘空间，安装时间约 10-30 分钟。

### 4. 安装项目依赖

```powershell
npm install
```

## 常见问题

### Q1: `cargo build` 失败，提示 `link.exe not found`

**原因**：MSVC 工具链未安装或未正确配置。

**解决**：
```powershell
# 检查
scripts\setup-env.ps1

# 自动修复
scripts\setup-env.ps1 -InstallMissing
```

### Q2: Tauri 启动失败，提示无法写入 APPDATA

**原因**：TRAE Sandbox 阻止应用访问 `C:\Users\<user>\AppData\Local\com.murasaki.app`。

**解决**：本项目已通过 `scripts/tauri-dev.ps1` 自动将 APPDATA 重定向到工作区 `.appdata/` 目录。直接运行 `npm run tauri:dev` 即可，**不要**直接执行 `npx tauri dev`。

### Q3: 之前的 GNU 工具链残留

**症状**：`rustup show` 显示 `stable-x86_64-pc-windows-gnu (active, default)`。

**解决**：
```powershell
rustup default stable-x86_64-pc-windows-msvc
# 可选：卸载 GNU 工具链
rustup toolchain uninstall stable-x86_64-pc-windows-gnu
```

并删除以下文件（如果存在）：
- `src-tauri/.cargo/config.toml`（含 `--allow-multiple-definition` 的 GNU workaround）
- `src-tauri/mingw.specs`

### Q4: 构建产物在哪里？

- 开发模式：`src-tauri/target/debug/murasaki.exe`
- 生产构建：`src-tauri/target/release/murasaki.exe`
- 安装包：`src-tauri/target/release/bundle/`

### Q5: 如何清理构建缓存？

```powershell
# 清理 Rust 构建缓存（约 2-5GB）
Remove-Item -Recurse -Force src-tauri\target

# 清理前端构建缓存
Remove-Item -Recurse -Force dist
Remove-Item -Recurse -Force node_modules\.vite
```

## 开发命令速查

| 命令 | 用途 |
|---|---|
| `npm run setup` | 检测环境 |
| `npm run setup:install` | 检测并自动安装缺失组件 |
| `npm run tauri:dev` | 启动开发模式 |
| `npm run tauri:build` | 生产构建 |
| `npm test` | 运行前端单元测试 |
| `npm run test:rust` | 运行 Rust 测试 |
| `npm run test:e2e:check` | 检查 E2E 环境 |

## IDE 配置建议

### VS Code

推荐扩展：
- `rust-lang.rust-analyzer`
- `Vue.volar`
- `tauri-apps.tauri-vscode`
- `esbenp.prettier-vscode`

### Rust Analyzer

如果 rust-analyzer 报错，确认 `rust-toolchain.toml` 或默认工具链是 MSVC：
```toml
# src-tauri/rust-toolchain.toml（可选）
[toolchain]
channel = "stable"
targets = ["x86_64-pc-windows-msvc"]
```
