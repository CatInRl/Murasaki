# Changelog

本文件记录 Murasaki 各版本的变更，遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范。

## [Unreleased]

## [0.2.0] - 2026-07-29

本版本引入完整的 Agent 能力（基于 OpenAI 兼容端点的 BYOK 助手），并刷新整体视觉风格以匹配 Murasaki 品牌。

### Added

- **Agent 面板与循环骨架（#20）**：右侧固定 380px 面板，支持流式输出（50ms 节流）、AbortController 取消、思考中禁用输入框并发送按钮变红 Stop，无工作区时面板整体禁用。
- **默认上下文 + CM6 状态类工具（#21）**：4 个前端工具 `get_current_document` / `get_selection` / `get_visible_range` / `get_outline`，默认上下文含完整当前文档（8K 阈值截断）、路径、frontmatter、光标与选区快照，UI 折叠卡片展示已包含项与 token 估算。
- **文件类工具与工作区边界（#22）**：3 个文件工具 `list_files` / `read_file` / `search_across_files`，Rust 侧解析路径必须落在工作区内，无工作区时 Agent 完全禁用。
- **Inline proposals + 新文件提案 + 合并关闭弹窗（#23, #24）**：行级 + 字符级 diff（>50 行降级为行级），绿色插入 / 红色删除装饰 + 右侧浮动 ✓/✗ 按钮 + 面板内可点击跳转的提案列表；文档变更后所有提案严格失效；`propose_replace` 超 50 行触发二次确认；`propose_new_file` 走现有"覆盖/重命名/取消"冲突弹窗，无效路径回退"另存为"；Agent 运行中关闭 tab 合并未保存确认弹窗（取消 / 不保存关闭 / 保存并关闭）。
- **对话持久化 + 工作区隔离 + 单实例锁 + 孤儿清理（#25）**：按工作区哈希隔离的对话历史，`chats/{hash}.json.gz`（gzip + 500ms debounce）+ `chats/index.json` 路径↔哈希映射；同一工作区单实例锁定（tauri-plugin-single-instance 比较 workspacePath argv），不同工作区独立 chat 文件；启动时扫描孤儿 chat 文件并提示手动确认清理。
- **上下文管理三层压缩 + 安全护栏（#26）**：Layer 1 工具结果省略 → Layer 2 滑动窗口 + 摘要（40K / 60K 阈值）→ 单请求 16K 截断 + 累计 50K 软提示；循环 15 轮上限；token 流式追踪通过 `result.usage.prompt_tokens` 精确累计。
- **Provider 配置 + DPAPI 加密（#19）**：系统设置内管理 AI Provider，支持新增 / 编辑 / 删除 / 设为活跃 / 测试连接；API Key 通过 Windows DPAPI 加密存储于 `%APPDATA%\murasaki\secrets.json`；DeepSeek 为默认预设；AI 面板顶部显示活跃 Provider 信息卡片与 BYOK 责任提示。
- AI Provider 配置 E2E 测试用例（#19）。
- Agent 全功能 E2E 测试覆盖 A–G 七层：Provider 配置（#19）、LLM 调用循环（C 层）、Proposals 渲染与接受（D 层）、对话持久化（E 层）、上下文压缩与护栏（F 层）、取消/中断（G 层），共 137/143 通过，剩余失败为 A 层测试隔离问题。

### Changed

- 视觉风格整体刷新以匹配 Murasaki 品牌：欢迎页三卡片布局 + 最近文件列表 + 背景装饰；大纲面板 dot 风格分层；文件树改用 SVG 图标；新增窄窗口断点（≤640px）与动画工具类。

### Fixed

- **修复 `OpenAICompatibleProvider.streamChatWithTools` 在 Tauri WebView2 中 hang 的问题**：openai npm 包的 `for await...of` 流迭代器在 WebView2 中无法推进，导致 Agent 发送消息后无响应。改用原生 `fetch` + `ReadableStream` + SSE 行解析替代，恢复流式输出与工具调用累积。
- **修复 Agent 上下文卡片首次打开 tab 时不渲染的问题**：`SourceEditor.onMounted` 调用 `registerView(view, null)` 会把 `activeDocPath` 重置为 `null`，覆盖 App.vue 中 watch 设置的值，导致 `agent.hasContext` 始终为 false。重构 `registerView` 不再管理 `activeDocPath`（改由 App.vue 的 watch 独占管理），并添加 `{ flush: 'post' }` 确保触发顺序。
- 修复 `search_across_files` 工具错误拒绝空 query 字符串：前端校验 `!query` 将空字符串视为参数缺失返回 "missing required parameter"，改为 `query == null` 仅拒绝 undefined/null，与 Rust 后端行为对齐。
- 修复 `search.rs` 存量测试失败：`test_search_regex` 因测试数据中 "Murasaki" 与 "editor" 不在同一行导致 0 vs 1 断言失败；`test_search_context_lines` 上下文行数断言与测试数据不匹配，已更新 `intro.md` 测试数据并修正断言。
- 修复 Tauri CLI 2.11+ 要求 `CI` 环境变量为 `"true"`/`"false"` 而 TRAE Sandbox 默认 `CI=1` 导致生产构建失败的问题，在 [tauri-build.ps1](scripts/tauri-build.ps1) 中覆盖为 `"true"`。

## [0.1.0] - 2026-07-23

Murasaki 首个正式版本：基于 Tauri 2.x + Vue 3 的本地 Markdown 文件管理与编辑器。

### Added

- 工作区（文件夹）管理 + 文件树（locale-aware 自然序排序：数字 → 英文 → 中文 → 其他）。
- 文件 / 文件夹拖拽物理移动、外部文件拖入复制、统一"覆盖/重命名/取消"冲突弹窗、删除走系统回收站。
- 多 tab 编辑（Ctrl+W 关闭、Ctrl+Tab 切换、中键关闭、关闭末尾 tab 回欢迎页）。
- CodeMirror 6 源码编辑（行号 + 软折行默认开启）+ Shiki 高亮 + markdown-it 解析。
- 实时预览：Mermaid 图、KaTeX 公式、emoji 短代码、任务列表可勾选回写源码、YAML frontmatter 卡片、内部链接新 tab 打开 / 外部链接系统浏览器 / 锚点滚动。
- 跨文件搜索（Ctrl+Shift+F）底部面板，支持正则、文件名与内容匹配。
- HTML 导出（Base64 内嵌图片 + 当前主题 CSS）。
- 状态栏：文件路径、光标位置、Unicode 字符数（不含空格），Alt+Shift+S 切换显隐。
- 系统设置（编辑分类含行号 / 软折行开关、AI Provider 配置）。
- 全屏 F11 自动隐藏状态栏；Ctrl+Shift+E 文件树 / Ctrl+Shift+M 大纲侧栏切换。

[Unreleased]: https://github.com/CatInRl/Murasaki/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/CatInRl/Murasaki/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/CatInRl/Murasaki/releases/tag/v0.1.0
