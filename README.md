# Murasaki

> 以日本平安时代女作家紫式部（Murasaki Shikibu）命名的桌面 Markdown 编辑器。
> 《源氏物语》作者、人类历史上第一位长篇小说作家 —— "书写创作"的化身。

一款使用 Tauri 2.x + Vue 3 + CodeMirror 6 构建的轻量级 Markdown 编辑器，专注于本地文件编辑与实时预览。

## 特性

- **本地文件优先**：直接操作磁盘上的 Markdown 文件，无需导入
- **实时预览**：基于 markdown-it + Shiki 的语法高亮渲染
- **扩展语法**：支持 Frontmatter、Mermaid 图表、KaTeX 数学公式、Emoji 短代码、任务列表、脚注等
- **多标签页**：同时编辑多个文件，支持草稿恢复
- **文件树与大纲**：侧栏切换显示项目结构或文档大纲
- **跨文件搜索**：支持正则表达式、文件名与内容搜索
- **主题系统**：内置 GitHub / Newsprint / Night / Academic 四套主题
- **HTML 导出**：图片以 Base64 内嵌，使用当前主题样式
- **图片处理**：剪贴板粘贴与拖放自动归档到 `assets/` 目录
- **外部修改检测**：文件被外部编辑器修改时弹窗提示重载

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Tauri 2.x（Rust 后端 + WebView 前端） |
| 前端框架 | Vue 3 + TypeScript |
| 状态管理 | Pinia |
| 编辑器 | CodeMirror 6 |
| Markdown 解析 | markdown-it + @shikijs/markdown-it |
| 数学公式 | KaTeX |
| 图表 | Mermaid |
| UI 组件 | Naive UI |

## 环境要求

- [Node.js](https://nodejs.org/) ≥ 18
- [Rust](https://www.rust-lang.org/tools/install) stable 工具链
- Windows: MSVC 或 GNU 工具链（需配合 MinGW）
- macOS / Linux: 标准构建工具链

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（启动 Tauri dev 窗口）
npm run tauri:dev

# 生产构建
npm run tauri:build

# 单元测试
npm test

# Rust 后端测试
npm run test:rust
```

## 项目结构

```
murasaki/
├── src/                    # 前端源码
│   ├── components/         # Vue 组件
│   ├── composables/        # 组合式函数
│   ├── stores/             # Pinia 状态管理
│   ├── utils/              # 工具函数
│   ├── App.vue
│   └── main.ts
├── src-tauri/              # Rust 后端
│   ├── src/
│   │   ├── commands/       # Tauri 命令
│   │   ├── lib.rs
│   │   └── main.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
├── docs/                   # 项目文档
│   ├── adr/                # 架构决策记录
│   └── spec.md
├── scripts/                # 构建辅助脚本
├── e2e/                    # 端到端测试
└── package.json
```

## 文档

- [产品规格说明](docs/spec.md)
- [架构决策记录](docs/adr/)

## 许可证

[MIT License](LICENSE)
