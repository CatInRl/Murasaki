# AGENTS.md

> **本文件是 AI 助手（Claude / Codex / 其他）在新会话开始时必读的入口文档。**
> 它汇总了本项目的关键约定，避免每次会话重新踩坑。

## 项目概览

- **Murasaki** — 基于 Tauri 2.x + Vue 3 的桌面 Markdown 编辑器
- 仓库：https://github.com/CatInRl/Murasaki
- 详细产品规格见 [docs/spec.md](docs/spec.md)
- 详细项目术语表见 [CONTEXT.md](CONTEXT.md)

## 开发环境（关键！）

**完整指南**：[docs/development-setup.md](docs/development-setup.md)

### 核心要点（避免踩坑）

1. **必须使用 MSVC 工具链**，不要用 GNU
   - 正确：`stable-x86_64-pc-windows-msvc`
   - 错误：`stable-x86_64-pc-windows-gnu`

2. **不要直接执行 `npx tauri dev`**，必须通过包装脚本：
   ```powershell
   npm run tauri:dev   # 自动配置 PATH + APPDATA 重定向
   npm run tauri:build # 生产构建
   ```
   脚本会处理 TRAE Sandbox 的 APPDATA 重定向到 `.appdata/`。

3. **环境检测**：
   ```powershell
   npm run setup            # 仅检测
   npm run setup:install    # 检测并自动安装缺失组件
   ```

4. **VS Build Tools 是必需的**（MSVC C++ 工作负载），不是可选的。
   - 缺失时 `cargo build` 报 `link.exe not found`

5. **永远不要**：
   - 在 `src-tauri/.cargo/config.toml` 中加 `--allow-multiple-definition`（GNU workaround）
   - 引入 `src-tauri/mingw.specs` 文件
   - 把 MinGW 路径硬编码到任何脚本

6. **优先使用 PowerShell 7 (`pwsh`)**，不要用系统自带的 Windows PowerShell 5.1 (`powershell`)：
   - 已通过 `winget install Microsoft.PowerShell` 安装到 `C:\Program Files\PowerShell\7\`
   - 命令别名位于 `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`
   - 新开会话后 `pwsh` 即可直接调用；当前会话 PATH 未刷新时可使用完整路径
   - 编写/执行 `.ps1` 脚本、调试命令、运行构建辅助脚本（如 [scripts/](scripts/)）时统一用 `pwsh`
   - 优势：跨平台、性能更好、支持 `??` `&&` `?:` 等现代语法、错误显示更友好
   - 仅当遇到依赖 .NET Framework 的旧 Windows 专属模块时才回退到 `powershell`

### 之前的 GNU workaround（已废弃，不要恢复）

历史会话曾经使用过这些 workaround，**它们都已删除且不应该重新引入**：
- `src-tauri/.cargo/config.toml`（含 `rustflags = ["-C", "link-arg=-Wl,--allow-multiple-definition"]`）
- `src-tauri/mingw.specs`
- `scripts/tauri-dev.ps1` 中硬编码 MinGW WinGet 长路径

如果你看到任何提示这些文件缺失的错误，**正确做法是切换到 MSVC 工具链**，而不是恢复这些文件。

## 项目结构

```
murasaki/
├── src/                    # 前端源码（Vue 3 + TypeScript）
│   ├── components/         # Vue 组件
│   ├── composables/        # 组合式函数
│   ├── stores/             # Pinia 状态管理
│   └── utils/              # 工具函数
├── src-tauri/              # Rust 后端
│   ├── src/commands/       # Tauri 命令（files, search, drafts, etc.）
│   └── Cargo.toml
├── scripts/                # 构建辅助脚本
│   ├── setup-env.ps1       # 环境检测与安装
│   ├── tauri-dev.ps1       # 开发模式启动器
│   └── tauri-build.ps1     # 生产构建启动器
├── docs/                   # 文档
│   ├── development-setup.md # 开发环境指南
│   ├── spec.md             # 产品规格
│   └── adr/                # 架构决策记录
├── e2e/                    # E2E 测试
└── AGENTS.md               # 本文件
```

## 构建与测试命令

| 命令 | 用途 |
|---|---|
| `npm run setup` | 检测本地环境 |
| `npm run setup:install` | 自动安装缺失组件 |
| `npm run tauri:dev` | 启动开发模式 |
| `npm run tauri:build` | 生产构建 |
| `npm test` | 前端单元测试 |
| `npm run test:rust` | Rust 测试 |
| `npm run build` | 仅构建前端（vue-tsc + vite build） |

## Git 提交约定

- 使用 Conventional Commits（中文描述可接受）
- 示例：`feat(editor): 添加滚动同步` / `fix(tabs): 修复关闭逻辑` / `docs: 更新环境指南`
- 不要提交：
  - `.appdata/`（运行时数据）
  - `src-tauri/target/`（构建产物）
  - `node_modules/`
  - `.scratch/`（临时调试脚本）
  - 任何机器特定路径配置

## Issue 跟踪约定

- **所有功能/spec 必须有 GitHub issue 跟踪**：用 `/to-spec` skill 生成 spec 并发布到 issue tracker，应用 `ready-for-agent` label
- **任务拆分必须用子 issue 跟踪**：spec issue 创建后，立即用 `gh issue create` 为每个任务创建独立子 issue，标题用 `T{簇号}.{序号} {任务名}` 格式
- **子 issue body 必含**：实施步骤 / 验收标准 / 依赖关系（引用依赖的 issue 编号）
- **子 issue 关联 spec issue**：在子 issue body 末尾用 `Part of #N` 引用 spec issue，让 GitHub 自动关联
- **spec issue 更新任务清单**：在 spec issue 添加 comment 列出所有子 issue 链接（或用 GitHub 的 task list 语法 `- [ ] T0.1 #N`）
- **禁止**：把多个任务塞在一条 comment 里 / 不创建 issue 直接开干 / 用本地 md 文件跟踪任务

## 架构决策

详见 [docs/adr/](docs/adr/)：
- ADR-0001：草稿恢复与 mtime 冲突解决机制
- ADR-0002：选择 Tauri 而非 Electron

## 变更记录

完整 changelog 详见 [CHANGELOG.md](CHANGELOG.md)。版本发布时必须同步更新该文件。

### 当前版本：0.3.0（2026-07-30）

**整体 UX 对齐 + WYSIWYG 模式**：8 个议题簇 25 个子 issue 全部完成。

- 设计系统：lucide 图标 + naive-ui themeOverrides + `--murasaki-*` token + 硬编码颜色清理
- 反馈系统：Toast / Dialog / ContextMenu 三套自建全局 store，替换 36 处原生弹窗
- 状态展示：EmptyState + ErrorState + Skeleton 三兄弟替换 naive-ui 默认
- WYSIWYG 模式：CodeMirror 6 内 Typora 路线，source/split/wysiwyg 三模式运行时切换
- 设置窗口：Tauri 多窗口 + 3 分类（常规/编辑器/AI）+ 显式 Save 模型
- Markdown 样式统一：`markdown-content.css` 共享 CSS，5 套主题，Murasaki 紫色品牌主题为默认
- Agent 面板全量视觉对齐 + WYSIWYG 原生兼容 Agent 提案

### 历史版本

- 0.2.0（2026-07-29）：Agent 能力（OpenAI 兼容端点 BYOK 助手 + 流式输出 + 提案 + 对话持久化 + 三层上下文压缩）
- 0.1.0（2026-07-23）：首个正式版本（工作区 + 文件树 + 多 tab + CM6 编辑 + 实时预览 + 跨文件搜索 + HTML 导出）

## 需要帮助时

- 环境问题 → 先读 [docs/development-setup.md](docs/development-setup.md)
- 产品行为问题 → 读 [docs/spec.md](docs/spec.md)
- 项目术语 → 读 [CONTEXT.md](CONTEXT.md)
- 历史决策 → 读 [docs/adr/](docs/adr/)
