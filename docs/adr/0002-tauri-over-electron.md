# ADR 0002: 选择 Tauri 而非 Electron

## 状态

已接受

## 背景

构建一个本地 markdown 文件管理工具，需要桌面应用形态（原生菜单、文件系统访问、文件夹树）。技术栈选择决定后续所有架构。

主流选项：
- **Electron** —— 成熟，JS/TS 生态庞大（CodeMirror/Monaco/markdown-it 全部支持）。Typora、Obsidian、Zettlr、MarkText 等同类产品几乎全部基于此。
- **Tauri** —— Rust 后端 + WebView 前端，体积小、内存低。
- **原生应用**（WinUI/WPF/Qt）—— 性能最佳，但 markdown 生态弱、开发量大。

## 决策

采用 **Tauri 2.x**。

## 理由

1. **体积与内存** —— Tauri 安装包 ~10MB，运行内存显著低于 Electron（~150MB 起步）。对单机工具是明显优势。
2. **安全模型** —— Tauri 的权限 scope（`allow`/`deny`）让文件系统访问可精确控制，与本项目的"工作区"概念天然契合（用户显式选目录后授予子树权限）。
3. **前端生态仍可用** —— CodeMirror 6、markdown-it、Shiki 均为纯 JS 库，在 Tauri 的 WebView 中运行无障碍。
4. **Rust 后端能力** —— 文件树遍历、大纲解析、文件监听等需要性能和系统访问的任务，Rust 端实现远优于 Node.js。

## 备选方案

**Electron** —— 生态最成熟、同类产品验证充分。但体积和内存成本对单机工具过高，且 Node.js 后端在文件系统密集操作上不如 Rust。若团队无 Rust 经验，Electron 是更稳的选择。

**原生应用** —— 性能最佳，但 markdown 编辑器生态（CodeMirror 等）不可用，等于重造轮子。

## 后果

**正面**
- 安装包小、内存低，对用户友好。
- 安全模型清晰，权限范围可精确声明。
- Rust 后端为文件操作、监听、解析提供性能保障。

**负面**
- Rust 学习曲线 —— 团队需具备 Rust 基础，自定义命令的开发效率低于纯 JS。
- 生态小于 Electron —— 遇到偏门问题时社区资料少。
- WebView 跨平台差异 —— Windows 上是 WebView2（Chromium），macOS 是 WKWebView（Safari），Linux 是 WebKitGTK，CSS/JS 兼容性需注意（本项目目标平台待定，暂按 Windows 优先）。
- 部分纯 JS 库（依赖 Node API 或 Web Worker 配置）需额外适配。
