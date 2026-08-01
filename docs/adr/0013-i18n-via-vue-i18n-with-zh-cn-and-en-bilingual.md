# ADR 0013: i18n 框架策略采用 vue-i18n + 中英双语

## 状态

已接受

## 背景

issue #95 提出 i18n 需求。当前应用所有 UI 文案为硬编码中文：

- **前端 Vue 层** —— 组件模板、对话框、toast、设置面板等直接写中文字串。
- **Rust 菜单层** —— [menu.rs](../../src-tauri/src/commands/menu.rs) 中 `SubmenuBuilder::new(app, "文件")` 等菜单标题与菜单项 label 硬编码中文（约 30 项）。

0.4.0 主题包含「分发与输出能力」，自动更新让应用触达更广用户群，i18n 是配套需求。经 grilling 确认范围边界：**框架准备 + 中/英双语**（不引入第三种语言，但框架要可扩展）。

核心问题：
1. 用哪个 i18n 框架。
2. Rust 端菜单文案如何本地化（前端框架管不到 Rust）。
3. 语言切换的持久化与运行时切换行为。
4. 默认语言策略。

## 决策

### 1. 框架：vue-i18n

采用 **vue-i18n 9.x**（Vue 3 官方推荐 i18n 库，Composition API 友好，支持懒加载 locale 文件、运行时切换、复数与插值）。

### 2. 范围：中英双语

- `zh-CN`（中文，默认）
- `en`（英文）

locale 文件按模块组织：

```
src/locales/
├── zh-CN/
│   ├── common.json      # 通用文案（确定/取消/保存等）
│   ├── menu.json        # 菜单相关
│   ├── settings.json    # 设置面板
│   ├── editor.json      # 编辑器
│   ├── agent.json       # Agent 面板
│   └── index.ts         # 聚合导出
├── en/
│   └── (同结构)
└── index.ts             # vue-i18n 实例创建
```

### 3. Rust 菜单文案处理（关键）

菜单在应用启动时由 Rust 构建（[menu.rs](../../src-tauri/src/commands/menu.rs) `build_app_menu`），此时前端尚未加载，无法直接用 vue-i18n。采用 **Rust 端小型翻译表 + 启动时读取语言设置** 方案：

- `tauri-plugin-store` 在 Rust 端也可读 settings.json，启动时读取 `settings.language` 字段（默认 `zh-CN`）。
- Rust 端新建 `src-tauri/src/i18n.rs`，含菜单文案的中英翻译表（`HashMap<&str, HashMap<Language, &str>>`），约 30 项。
- `build_app_menu` 调用 `t("menu.file")` 等 helper 获取当前语言对应的字串。
- 语言切换时：前端更新 settings.json → 调用 Tauri 命令 `reload_menu` → Rust 重新读取语言 + 重建菜单。

**已知折衷**：前端 vue-i18n 与 Rust 翻译表是两套独立翻译源，存在重复维护。对 0.4.0 仅 30 项菜单文案的双语规模，此折衷可接受。若未来语言数量增长（3+），再评估统一方案（如构建时从 JSON 生成 Rust 常量）。

### 4. 语言切换与持久化

- 设置面板「常规」分类新增「语言 (Language)」下拉：中文 / English。
- 切换即生效（运行时切换，无需重启）：
  - 前端：`i18n.global.locale.value = lang` 即时更新所有 Vue 组件。
  - Rust：调用 `reload_menu` 命令重建菜单。
- 持久化到 `settings.json` 的 `language` 字段。
- 启动时读取该字段初始化 i18n locale（vue-i18n 在 `main.ts` 创建实例前同步读取）。

### 5. 默认语言

- 默认 `zh-CN`（与当前行为一致，不破坏现有用户体验）。
- 首次启动不探测系统语言（避免突兀，用户可在设置切换）。
- 后续版本可考虑探测系统 locale 作为首次默认。

### 6. 不翻译的内容

以下内容**保持不翻译**（设计决策，非范围限制）：

- **markdown 主题名** —— GitHub / Newsprint / Night / Academic / Murasaki（品牌名/风格名，国际通用）。
- **代码块语言标签** —— `typescript` / `rust` 等（技术术语）。
- **Agent 工具名** —— `propose_insert` 等（技术标识符）。
- **markdown 语法** —— `# 标题` / `**粗体**` 等（语法本身）。
- **设置项的「恢复默认 / 保存」按钮** —— 这两个按钮翻译，但 markdown 主题名不翻译。

## 理由

1. **vue-i18n 是 Vue 3 生态事实标准** —— 与 Composition API 集成自然、社区活跃、文档完善、TypeScript 支持良好。无需评估替代方案。
2. **中英双语覆盖最大用户群** —— 中文是现有用户主语言，英文覆盖国际用户与开发者社区。0.4.0 自动更新触达更广用户后，英文支持是必要的最小集。
3. **框架可扩展** —— vue-i18n 支持后续加 locale 文件即新增语言，Rust 翻译表的 `Language` enum 也可扩展。0.4.0 不做第三种语言，但路径打通。
4. **Rust 菜单翻译表是 0.4.0 规模下的最小成本方案** —— 30 项菜单文案双语化，自建 HashMap 比引入 Tauri i18n plugin 或构建时生成方案都简单。规模增长后再优化。
5. **运行时切换提升体验** —— 不需重启即可切换语言，对中英用户切换场景友好。
6. **默认 zh-CN 保护现有用户** —— 0.3.x 用户升级到 0.4.0 后界面语言不变，无突兀感。

## 备选方案

**Tauri i18n / Fluent** —— 用 Mozilla Fluent（Project Fluent）作为统一 i18n 方案，前端后端共享 `.ftl` 文件。被否决：Fluent 学习成本高、Vue 生态集成不成熟、30 项菜单文案用不上 Fluent 的复数/性别等高级特性。

**构建时从 JSON 生成 Rust 常量** —— locale JSON 是单一来源，构建脚本生成 `menu_locales.rs`。被否决：0.4.0 规模过小，构建脚本复杂度高于收益。若语言数 ≥3 再评估。

**仅前端 i18n，菜单保持中文** —— 只翻译 Vue 层，菜单维持硬编码中文。被否决：菜单是应用门面，中英用户都会看到菜单，不翻译体验割裂。

**探测系统语言作为默认** —— 首次启动读 OS locale 决定默认语言。被否决：0.4.0 不做，避免现有中文用户在英文 OS 上首次启动看到英文界面产生困惑。后续版本可加。

## 后果

**正面**
- 中英用户均可无障碍使用应用。
- i18n 框架就位，后续加语言成本低。
- 语言切换即时生效，体验流畅。

**负面**
- 前端 vue-i18n 与 Rust 翻译表双源维护，菜单文案改动需同步两处（0.4.0 规模可接受，加语言时需优化）。
- 现有所有 Vue 组件的中文字串需提取为 i18n key，是一次性较大重构工作（机械但量大）。
- Rust 端需在 `build_app_menu` 启动路径加一次 settings 读取（轻微延迟，可忽略）。
- 测试需覆盖两种语言的 UI（E2E 测试矩阵翻倍，但 0.4.0 可只对核心流程跑双语，非核心仅中文）。

## 实施边界

### 文件改动

- `package.json` —— 加 `vue-i18n` 依赖。
- 新建 `src/locales/zh-CN/*.json` 与 `src/locales/en/*.json` —— 各模块翻译文件。
- 新建 `src/locales/index.ts` —— 创建 i18n 实例，导出 `i18n` 与 `useI18n` 辅助。
- 改 `src/main.ts` —— `app.use(i18n)`。
- 改所有 Vue 组件 —— 模板中字串替换为 `$t('key')`，脚本中用 `const { t } = useI18n()`。
- 新建 `src-tauri/src/i18n.rs` —— Rust 端菜单翻译表 + `t()` helper。
- 改 `src-tauri/src/commands/menu.rs` —— `build_app_menu` 用 `t("menu.file")` 替代硬编码。
- 改 `src-tauri/src/lib.rs` —— 启动时读 settings 初始化语言状态。
- 新增 Tauri 命令 `reload_menu` —— 重新读取语言并重建菜单。
- 改 `src/types.ts` —— `SettingsState` 加 `language: "zh-CN" | "en"` 字段。
- 改 `src/settings/panels/GeneralPanel.vue` —— 新增「语言」下拉。
- 改 `src/composables/useCommands.ts` —— 语言切换时调 `reload_menu`。

### 翻译范围

0.4.0 翻译覆盖：
- 菜单栏全部项（文件/编辑/段落/主题/帮助）
- 设置面板全部项（常规/编辑器/AI）
- 所有对话框与 toast
- 欢迎页
- 状态栏
- Agent 面板

### 测试

- 单元测试：vue-i18n locale 切换、缺失 key 回退行为。
- 集成测试：语言切换后菜单重建正确。
- E2E：核心流程（打开文件 / 编辑 / 保存 / 导出）跑双语验证。

### 范围外

- 第三种语言（日/韩等）—— 0.4.0 不做，框架预留。
- 探测系统语言作为默认 —— 后续版本。
- 统一前后端翻译源（构建时生成）—— 语言数 ≥3 时评估。
- markdown 内容翻译 —— 不做（用户内容不干预）。
