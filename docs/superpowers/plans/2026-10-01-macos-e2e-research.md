# macOS E2E 调研与并行策略（2026-10-01）

> 背景：Linux e2e 已随 #339/#343 落地（`a8a72ed`）。本文回答两个问题：**① macOS e2e 怎么搞；② e2e 能不能并行跑**。所有外部结论均给出来源；仓库侧结论来自对当前代码的直接分析。

## 结论摘要

| 问题 | 结论 |
|---|---|
| macOS e2e 用什么驱动 | **tauri-driver 走不通**（从未支持 macOS）。唯一有生产级证据的路线是 **应用内嵌 WebDriver server**：`@wdio/tauri-service` 的 **embedded provider**（Rust 插件 `tauri-plugin-wdio-webdriver`）或 crabnebula 的 `tauri-plugin-automation` |
| safaridriver 行不行 | **死路**：只驱动 Safari，单 session、无 headless，无法驱动 WKWebView 应用。tauri 官方 draft PR 已明确拒绝该方案 |
| e2e 能否并行 | **job 级可以且已经在并行**（test.yml 现有 4 个 job 互不依赖即并行）；公共仓库 macOS runner 免费。**job 内不建议并行**：`fileParallelism: false` 是有意串行，embedded provider 自身也限 `maxInstances: 1` |

---

## A. 为什么现有路线（tauri-driver + 手工 POST /session）在 macOS 走不通

### A1 tauri-driver 从未支持 macOS

- tauri-driver 源码按 `#[cfg]` 排除 macOS 编译目标，Windows 用 msedgedriver、Linux 用 WebKitWebDriver，macOS 分支不存在。
- 支持 macOS 的请求 issue 至今 open，无实现计划：
  https://github.com/tauri-apps/tauri/issues/7068

### A2 safaridriver 是死路

- tauri 的 draft PR 曾探讨用 safaridriver 兜底，被明确否决——理由是 safaridriver 只能驱动 Safari（*“safaridriver only drives Safari”*），而 WKWebView 应用不是 Safari：
  https://github.com/tauri-apps/tauri/pull/15295
- Apple 官方文档同样限定 safaridriver 的自动化对象是 Safari，且限制为单 session、不支持 headless：
  https://developer.apple.com/documentation/webkit/testing_with_webdriver_in_safari

### A3 根因：WKWebView 没有系统级 native driver

Windows 上 WebView2 可以被 msedgedriver 直接驱动、Linux 上 WebKitGTK 有 WebKitWebDriver，都是因为它们暴露了系统级的 WebDriver 端点。WKWebView 是**应用进程内的嵌入视图**，没有对应的外部驱动程序——这就是 A1/A2 的底层原因，也解释了为什么嵌入式方案是唯一出路。

---

## B. 可行路线：应用内嵌 WebDriver server

### B1 embedded provider（推荐）

`@wdio/tauri-service` 提供 embedded provider：在 Rust 侧注册 `tauri-plugin-wdio-webdriver`，应用自己启动一个 W3C WebDriver server，测试进程直接对它建 session（不再需要 tauri-driver / msedgedriver / WebKitWebDriver 任何外部驱动）。

要点：
- 插件注册放 `#[cfg(debug_assertions)]` 下，不进生产二进制；
- capability 需要加 `wdio-webdriver:default`；
- **debug 裸二进制即可**，不需要打包 `.app`（CI 上省掉 bundle 步骤）；
- 仓库：https://github.com/webdriverio/desktop-mobile （原 `webdriverio-community/wdio-tauri-service` 只是空壳占位，2025 年起服务与 Rust 插件均迁入 `webdriverio/desktop-mobile` monorepo 的 `packages/tauri-service/` 与 `packages/tauri-plugin/`）

### B2 crabnebula provider（备选）

crabnebula 的 `tauri-plugin-automation` 提供同类能力（应用内自动化 server）：
https://github.com/crabnebula-dev/tauri-plugin-automation

### B3 生产级证据

desktop-mobile 仓库（webdriverio 官方桌面/移动 service monorepo）自己的 e2e 在 GitHub Actions 上有 **多个 macOS job（embedded 与 crabnebula 各半）持续全绿**，其平台支持矩阵标注 macOS ✅：
https://github.com/webdriverio/desktop-mobile/tree/main/e2e

### B4 反向证据

tauri 官方仓库的 webdriver-example（走 tauri-driver 的示例）**只有 Windows / Linux，没有 macOS**——与 A1 互为印证：
https://github.com/tauri-apps/tauri/tree/dev/examples/webdriver

---

## C. 仓库现状与差距（对照当前代码）

### C1 harness 架构

e2e 跑在 **vitest** 上（不是 wdio testrunner）：[e2e/vitest.config.ts](../../e2e/vitest.config.ts)。session 由 [e2e/helpers/driver.ts](../../e2e/helpers/driver.ts) 用 Node 原生 http 手工 `POST /session` 到 tauri-driver（4444），再 `attach()`——手工 http 是为绕开 webdriverio 9 的 undici 与 tauri-driver hyper 的 `IncompleteMessage` 不兼容。

**对 macOS 的含义**：attach 模式与 130+ spec 本体都是平台无关的标准 WebDriver API，可整体保留；需要换的只有「session 建立目标」——从 tauri-driver 换成应用内 server 的端口。

### C2 `is_e2e_mode` 判定缺 macOS 通道

[lib.rs](../../src-tauri/src/lib.rs) 的 `is_e2e_mode_from(argv, env_additional_args, automation_env)` 目前有两条通道：
- Windows：argv `--remote-debugging-port=`，或 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 含端口 + `--test-type=webdriver`；
- Linux：`TAURI_WEBVIEW_AUTOMATION=true` / `TAURI_AUTOMATION=true`。

macOS（embedded provider 拉起应用时注入什么环境/参数）需按 B1 插件的实际机制补第三条通道，否则单实例插件会干扰 session（与 Linux e2e #339 Task 1 同型问题）。

### C3 setup.ts / driver.ts 的平台分支

- [e2e/setup.ts](../../e2e/setup.ts)：`findNativeDriverPath()` 仅 Windows（msedgedriver）；tauri-driver 的 `--native-driver` 参数也仅 Windows 需要。macOS embedded 路线下**两者都不需要**——setup 分支应为：不做 driver 查找/启动，只保留进程清理 + `ensureChineseLocale()` 预写 settings.json（e2e 断言全基于中文文案，见 AGENTS.md e2e 节）。
- `appDataDir()` 的 macOS 分支已正确指向 `~/Library/Application Support/com.murasaki.app`，`ensureChineseLocale` 无需改。

### C4 状态隔离（一个待验证的 caveat）

| 平台 | 应用数据目录 | CI 隔离手段 |
|---|---|---|
| macOS | `$HOME/Library/Application Support/com.murasaki.app` | 重定向 `$HOME`（dirs-sys 的 `home_dir` 读 `$HOME` env，可重定向）|
| Linux | `$XDG_DATA_HOME` 或 `~/.local/share` | `XDG_DATA_HOME` / `TMPDIR`（#343 已用）|
| Windows | Rust 侧用 `SHGetKnownFolderPath`，**不受 `APPDATA` env 影响** | `WEBVIEW2_USER_DATA_FOLDER` / Tauri override |

**Caveat（需实测）**：[e2e/setup.ts](../../e2e/setup.ts) 的 `appDataDir()` 在 Windows 读 `process.env.APPDATA`，而 Rust 侧 `app_data_dir` 走 `dirs-sys` → `SHGetKnownFolderPath`，**env 重定向可能不影响它**——这意味着 setup.ts 预写的 settings.json 与应用实际读写的目录可能不是同一处。这与 [scripts/tauri-dev.ps1](../../scripts/tauri-dev.ps1) 的 `.appdata/` 重定向假设直接相关，列入验证项（不影响 macOS 方案本身）。

### C5 并行现状（代码事实)

- [.github/workflows/test.yml](../../.github/workflows/test.yml)：`frontend` / `rust` / `e2e`(win) / `e2e-linux` 四个 job **互不依赖，天然并行**。
- [e2e/vitest.config.ts](../../e2e/vitest.config.ts)：`fileParallelism: false` + `isolate: false`——**有意串行**，避免多个 Tauri 实例同时启动（4444/4445 端口、settings.json、进程清理互相踩）。
- [e2e/helpers/driver.ts](../../e2e/helpers/driver.ts)：`DRIVER_PORT 4444` 固定；4444 起而 4445 未起的孤儿态判定为不可恢复。

---

## D. 并行策略结论

### D1 job 级：可以，且已经是

- GH Actions 的 job 默认并行，只有 `needs` 才引入串行——新增 `e2e-macos` job 与现有 4 job 并行，**改造成本为 0**。
- 公共仓库 runner 免费（macOS 计 10 倍分钟数，但 public repo 分钟数倍率为 0x）：https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions
- `macos-latest` 即 macos-15 arm64：https://github.com/actions/runner-images

### D2 job 内：不建议

- `fileParallelism: false` 是踩坑后的设计选择（多 Tauri 实例互踩），不是顺手关掉的。
- embedded provider 官方建议 `maxInstances: 1`；真要双实例需 multiremote + 不同端口（4445/4446），且数据目录隔离要自己补。
- macOS runner 上 GUI 焦点类测试（多窗口、右键菜单被滚动收起等本仓库已知坑）在无头/并行环境下的行为未知（见 F 证据缺口）。

### D3 推荐

**跨平台并行（win e2e + linux e2e + mac e2e 三个 job 同时跑）：✅ 推荐**。同平台内多 spec 并行：❌ 维持串行。

---

## E. 若立项 macOS e2e：建议方案

1. **Rust 侧**：加 `tauri-plugin-wdio-webdriver`（`#[cfg(debug_assertions)]` 注册）、capability `wdio-webdriver:default`；`is_e2e_mode` 补 macOS 判定通道 + 单测（对齐 #339 Task 1 的 TDD 手法）。
2. **harness**：`setup.ts` 加 macOS 分支（无外部 driver；`$HOME` 重定向做状态隔离；`ensureChineseLocale` 复用）；`driver.ts` 的 session 创建目标参数化（tauri-driver 或应用内 server 二选一），attach 流程与 waitfor 默认值不动。
3. **CI**：test.yml 新增 `e2e-macos` job（`npx tauri build --no-bundle` 的 macOS 等价物 = `cargo build` debug 裸二进制即可），首期**「只跑不拦」**（对齐 #261 → e2e-linux 的先例），稳定后再提升 required。
4. **验证项**：C4 的 Windows `APPDATA` 重定向 caveat；WKWebView 下 `execute`/`executeAsync` 的实际可用性；GUI 焦点类 spec 的表现。

## F. 证据缺口（首跑前确认）

- embedded provider 在 WKWebView 应用上 `execute` / `executeAsync` 的实际行为（desktop-mobile 全绿是间接证据）。
- macOS CI 上 GUI 焦点类测试（多窗口 / 右键菜单收起）的可靠性报告。
- multiremote 双实例的数据目录隔离机制（若将来尝试 job 内双实例才需要）。

## 引用来源

- https://github.com/tauri-apps/tauri/issues/7068 —— tauri-driver macOS 支持请求（open）
- https://github.com/tauri-apps/tauri/pull/15295 —— safaridriver 方案被拒（draft）
- https://developer.apple.com/documentation/webkit/testing_with_webdriver_in_safari —— safaridriver 能力边界
- https://github.com/webdriverio/desktop-mobile —— embedded/crabnebula provider（tauri-plugin-wdio-webdriver；原 webdriverio-community/wdio-tauri-service 已并入）
- https://github.com/crabnebula-dev/tauri-plugin-automation —— crabnebula 自动化插件
- https://github.com/webdriverio/desktop-mobile/tree/main/e2e —— 官方 macOS e2e CI 全绿实证 + 平台支持矩阵
- https://github.com/tauri-apps/tauri/tree/dev/examples/webdriver —— tauri 官方 webdriver 示例（无 macOS）
- https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions —— macOS runner 计费
- https://github.com/actions/runner-images —— `macos-latest` = macos-15 (arm64)
