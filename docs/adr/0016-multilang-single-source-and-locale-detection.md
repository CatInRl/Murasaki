# ADR 0016: 多语言支持落地（日语 + 菜单单源化 + 系统语言探测）

## 状态

已接受

## 背景

[ADR-0013](0013-i18n-via-vue-i18n-with-zh-cn-and-en-bilingual.md) 建立了中英双语 i18n 框架，并明确记录了三个「后续评估」项：加语言数 ≥3 时统一前后端翻译源、探测系统语言作为首次默认。本次（跨 0.8.x 的多语言地图，wayfinder:map #146）把这三项与「新增首个第三方语言」一并落地，使应用从固定中英双语进阶为可扩展的多语言应用。

## 决策

### 1. 新增日语（ja）作为首个第三方语言

- 在 `src/locales/ja/` 提供与 zh-CN 同构的模块（common/menu/settings/editor/agent），由 AI 产出初稿后维护者校对。
- 语言元数据与 message 注册收敛到单一事实来源 `src/locales/registry.ts`（`LOCALE_DEFS`、`AppLocale`、`SUPPORTED_LOCALES`、`DEFAULT_LOCALE`、`localeMessages`）。新增语言只需加一个 `LOCALE_DEFS` 条目 + 对应 locale 目录，下拉/类型/messages 自动跟随。
- `types.ts` 的 `AppLocale` 改由 registry 派生并 re-export，删除硬编码 `"zh-CN" | "en"`。

### 2. 前端 locale 单点注册（registry.ts）

语言下拉（`GeneralPanel.vue`）、vue-i18n messages、语言类型全部数据驱动自 `LOCALE_DEFS`，不再硬编码语言数组。

### 3. key 同步校验（自动化）

新增 `locales.test.ts`，以 zh-CN 为基准（`collectKeyPaths` 展平后对比 key 路径集合），逐一校验每个其他语言（en/ja/…）各模块（common/menu/settings/editor/agent）的 key 树与其**完全一致**。任一语言多 key / 少 key 都令测试失败，从机制上防止多语言 key 漂移。

### 4. Rust 菜单单源化（取代 ADR-0013 的双源折衷）

随语言数达 3，双源（前端 JSON + [i18n.rs](../../src-tauri/src/i18n.rs) 硬编码翻译表）维护成本不可接受。改为：

- [build.rs](../../src-tauri/build.rs) 构建时遍历 `src/locales/*/menu.json`，用 serde_json 展平嵌套 JSON（点号 key），生成 `OUT_DIR/menu_locales.rs` 平铺常量（`SUPPORTED_LANGS` + `MENU_TEXTS: &[(&str, &str, &str)]` = `(lang, key, label)`），并对每个 menu.json 打 `cargo:rerun-if-changed`。
- [i18n.rs](../../src-tauri/src/i18n.rs) 用 `include!` 引入生成物，删除 `MenuTexts` 结构体与 `zh_cn_texts()/en_texts()`，改为 `menu_text(lang, key)` 线性查询。
- [menu.rs](../../src-tauri/src/commands/menu.rs) `build_app_menu` 改为按 menu.json 的实际 key（如 `file.newFile`/`paragraph.heading1`）查询 label，不再依赖逐一字段。

单一 JSON 来源；新增语言 = 加 menu.json 目录 + 重建即自动生效，Rust 侧零手改。

### 5. 首次启动探测系统语言（仅一次）

- 新增 Rust 命令 `detect_system_locale`（依赖 `sys-locale` crate）：`sys-locale::get_locale()` → 映射到受支持语言（含 `zh`→`zh-CN`、含 `ja`→`ja`、其余/None→`en`）。
- 前端 `usePersistenceStore` 在 `loadSettings` 时判定 `languageEmpty`（`saved` 为空或 `saved.language === undefined` 视为「language 从未写入」），仅此情形才在 `App.vue` 启动段调用探测、归一（`mapSystemLocale` 纯函数，可单测）、持久化，再 `setLocale` + `reload_menu`。
- 已持久化过语言的既有用户（含旧的中文/英文用户）**跳过**探测，保持原设置，升级无突兀。

### 6. 回退语言

`i18n.ts` fallback 由 zh-CN 改为 **en**，保证新语言的缺失长尾 key 回退英文而非中文；en 与 zh-CN 的 key 树已由 `locales.test.ts` 强制一致，回退安全。

## 理由

1. **日本语是合理的首个第三方语言** —— 用量可观、翻译成本可控，且能验证框架可扩展性（注册表 + key 校验 + 单源化）。
2. **registry 单点注册消除了硬编码语言数组** —— 语言数增长时无需改多个文件，符合 ADR-0013「路径打通」的方向。
3. **key 同步校验用测试兜底防漂移** —— 这是比人工检查可靠得多的机制约束，新增语言必须 key 全对齐才能过 CI。
4. **build.rs 单源化在语言 ≥3 时收益明确** —— 把「双源同步维护」替换为「构建时生成 + include」，消除手写翻译表；`cargo:rerun-if-changed` 保证 JSON 变更即重生成，与测试共同防漂移。
5. **首次探测仅一次且保护既有用户** —— 探测结果一旦写入 `language` 字段，后续启动不再探测；旧用户不受影响，只有全新安装（或语言字段从未存在的首次运行）才被系统语言接管默认值。
6. **fallback=en 更符合多语言语义** —— 新语言缺 key 显示英文比显示中文对国际用户更友好，且 key 树校验消除了「回退异常」的担忧。

## 备选方案

**Rust 运行时读 JSON（而非构建时生成）** —— `include_str!` + 运行时 JSON 解析。被否决：menu JSON 嵌套结构手写 const fn 解析繁琐，且把解析成本放到运行路径；构建时生成平铺常量更简单、零运行时开销。

**保持双源 + 依赖 key 校验测试兜底** —— 被否决：语言数达 3+ 后每次新增都在三处（前端 JSON ×N + Rust i18n.rs）同步，即便有测试兜底，维护成本仍高，且测试只能防「漏」，不能消除「重复维护」。

**首次启动始终探测 / 每次都探测** —— 被否决：前者破坏既有中英用户的界面预期，后者浪费且每次可能跳语言。

## 后果

**正面**
- 语言扩展从「三处同步」降为「加目录 + 重建」，新增语言成本大幅下降。
- Rust 菜单与前端文案单一来源，不再有第二份手写菜单文案。
- 全新安装用户首次启动获得与其系统语言一致（在支持集合内）的界面。
- key 漂移被测试机制拦截。

**负面**
- build.rs 增加构建期一次性成本（读 JSON + 生成源码），可忽略但存在。
- 首次探测依赖系统 locale 可靠性；无法获取时回退 en。
- 探测仅在全新安装触发，已有 `language` 字段的用户即使切换 OS 语言也不跟动（符合「仅首启探测」的设计边界）。

## 实施边界

### 文件改动

- 新建 `src/locales/ja/*`、`src/locales/registry.ts`、`src/locales/locales.test.ts`、`src/utils/systemLocale.ts`(+test)、`src-tauri/src/commands/locale.rs`。
- 改 `src/i18n.ts`、`src/types.ts`、`src/settings/panels/GeneralPanel.vue`、`src/stores/usePersistenceStore.ts`、`src/App.vue`、`src-tauri/build.rs`、`src-tauri/src/i18n.rs`、`src-tauri/src/commands/menu.rs`、`src-tauri/src/commands/mod.rs`、`src-tauri/src/lib.rs`、`src-tauri/Cargo.toml`（加 `sys-locale`、build-dep `serde_json`）。

### 测试

- `locales.test.ts`：en/ja 各模块与 zh-CN 的 key 树完全一致。
- `systemLocale.test.ts`：映射规则（zh→zh-CN、ja→ja、en/其他/None→en）。
- Rust：`menu_text` 查询 + 既有 63 项测试通过。
- 前端全量 vitest + `vue-tsc --noEmit`。

### 范围外

- 除日语外其他语言的翻译内容（框架已支持，本次只铺日语）。
- markdown 内容/文档翻译（用户内容不干预，延续 ADR-0013）。