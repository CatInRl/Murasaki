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
| `npm run test:e2e` | E2E（真实 WebView2；需先构建 + 装 tauri-driver/msedgedriver） |
| `npm run build` | 仅构建前端（vue-tsc + vite build） |

## 开发流程

**分支模型**：`main` 恒为可发布状态，所有改动经短生命周期分支 + PR 合入（详见 [ADR-0019](docs/adr/0019-trunk-based-development-with-pull-requests.md)）。**不引入 develop / release 分支**。

1. **先有 issue**：任何改动都要有 issue 跟踪（见下「Issue 跟踪约定」），禁止无 issue 开工。
2. **切分支**：从最新 `main` 切出 `<type>/<issue>-<slug>`，例如 `fix/198-multi-window-deadlock`、`docs/205-dev-workflow`。`<type>` 取 Conventional Commits 类型（feat / fix / docs / refactor / test / chore）。分支名必须带 issue 号，所以**先有 issue 才有分支**。**不要在 main 上直接提交**。
3. **开 PR**：推送分支后开 PR，标题格式 `<type>(<scope>): <描述> (#<issue>)`，描述按 [.github/pull_request_template.md](.github/pull_request_template.md) 模板填写（dependabot 等机器人开的 PR 不受此标题格式约束）。
4. **过门禁**：[.github/workflows/test.yml](.github/workflows/test.yml) 中 `frontend`、`rust`、`e2e` 三个 job 必须全绿——
   - `frontend`（ubuntu-24.04）：`npm test` + `npm run build`
   - `rust`（windows-latest）：`npm run build` + `npm run test:rust`（`tauri.conf.json` 的 `frontendDist` 指向 `../dist`，需先产出 dist）
   - `e2e`（windows-latest）：tauri-driver + msedgedriver 驱动**真实 WebView2**，跑 `npx tauri build --no-bundle` + `npm run test:e2e`

   `e2e` 于 **2026-09-26 提升为必过项**（此前只跑不拦，见 #261；提升的依据是修掉三类 flake 后连续 4 次跑绿：应用就绪未等 #266、元素等待不重试 #268、只等容器不等节点 #270。提升后它的第一次运行就拦下第四类 flake —— 右键菜单被滚动收起，见 #273）。代价是每个 PR 多等约 15–23 分钟；若某次确认是环境抖动而非回归，可 `gh run rerun <run-id> --failed` 重试，确需临时降级时改分支保护的 required status checks（`gh api repos/CatInRl/Murasaki/branches/main/protection/required_status_checks -X PATCH ...`）。

   **e2e 的坑（都踩过，别再踩）**：
   - 被测二进制必须走 Tauri CLI（`npm run tauri:build` 或 `npx tauri build --no-bundle`）。裸 `cargo build --release` 产出的二进制**前端起不来**（webview 停在 `title="localhost"`），整套 e2e 会系统性失败、极易误判成代码回归。
   - 跑之前不能有残留的 tauri-driver / msedgedriver 占用 4444/4445：`e2e/setup.ts` 会复用外部 driver，若它是半死状态，之后所有 session 报 `ECONNRESET`。跑前先清进程。
   - **界面语言必须固定为 zh-CN**：e2e 断言全基于中文文案，而应用首次启动会按系统语言自动探测并持久化（CI runner 是 en-US）。`e2e/setup.ts` 的 globalSetup 会在启动前把 `%APPDATA%\com.murasaki.app\settings.json` 的 `language` 预置为 zh-CN，别把它删掉。
   - **session 建好必须等应用就绪**：WebView2 起来不代表前端就绪，Vue/Pinia 加载期间 `window.__pinia__` 是 `undefined`，此时任何读 store 的 helper 都抛 `Cannot read properties of undefined (reading '_s')`。这一步已收进 `e2e/helpers/driver.ts` 的 `createSession()`（内部 `waitForPinia`），**别把那段等待删掉**——#266 之前靠各 spec 自己记得调用，`detailed.spec.ts` 漏了就在 CI 上整文件 23 条全灭。**`__pinia__` 就绪 ≠ 应用恢复完毕**：`App.vue` 的 `onMounted` 之后还有一串 `await`（恢复上次设置 / 工作区 / 标签，#315），不等它就直接清场会被恢复覆盖（表现为 `.file-tree` 永不出来、欢迎页不在 DOM，CI 上约 10%）。故 `createSession()` 里紧跟 `waitForPinia` 还有一个 `waitForAppReady`（判据是 `App.vue` 在 `initialized.value = true` 处挂的 `window.__appReady__` —— 它一定晚于那三处恢复），**同样别删**。注意该判据是**按窗口**的：`createSession` 只保证它当时落到的那个句柄就绪，切到应用新建窗口的用例（如 `multi-window.spec.ts`）需自行等目标窗口的初始化。
   - **元素等待命令不重试**：`waitForExist` / `waitForDisplayed` 等在本栈下是**单次判定**——对不存在的元素 `waitForExist({ timeout: 15000 })` 实测 **~10ms 就抛错**（错误文案却写「after 15000ms」，纯属文案）。本地跑得快所以一直没暴露，CI 慢就带来成片的「等不到元素」。**要等 UI 出现就用 `e2e/helpers/wait.ts` 的手写轮询**（`waitForPresent` / `waitForAbsent` / `waitForRendered` / `waitForInBrowser`），**别再用元素等待命令**（#268 已把全套 130 余处调用点换掉）。`browser.waitUntil` 也是同一类坑（#300）：**只有拿到数字型的 `interval` 才会重试** —— 实测条件恒返回 false 时，`{ timeout: 20000 }` **1 次、0–15ms 就抛** `waitUntil condition timed out after 20000ms`（耗时是假的），`{ timeout: 20000, interval: 200 }` 才 101 次 / 20008ms（机制见 `node_modules/webdriverio/build/index.js:6435-6448`：解构默认值取 `this.options.waitforInterval` 再用 `typeof` 兜一次，两者都取不到数时 interval 为 NaN，首轮即判超时）。根因是本仓库的 session 由 `attach()` 复用、**不合并 `remote()` 的默认配置**，`options.waitforInterval` 为 undefined（由此，此前「waitUntil 正常重试」的结论是错的：当年那次实测带了 `interval 300ms`）。`helpers/driver.ts` 的 `createSession` 现已补上该默认值，所以只写 `{ timeout }` 照常轮询；但**不要绕过 `createSession` 自建 session**，否则又退回单次判定。另外预算要**大于被等对象自身的兜底**（例：等 `workspace.loading` 归位就得 >30s，因为 `refreshTree` 自己有 30s 超时兜底，给正好 30s 必然抢跑输——#266）。
   - **右键菜单会被任意滚动收起**：`ContextMenuContainer` 在 window 上以 **capture 阶段**注册了 `scroll` / `resize` → 关闭菜单。若用例刚 `openWorkspace`（刷新、把目标滚入视区都可能紧跟其后）就开菜单，菜单会被立刻收掉，表现为「等不到 `.murasaki-context-menu`」。**开菜单前先让树安静下来**（节点渲染 + `workspace.loading === false` + 一段安静期，用 `e2e/helpers/tree.ts` 的 `waitForTreeSettled`），必要时按 #273 的做法**有界重派发**（`file-operations.spec.ts` 的 `openTreeNodeContextMenu`、`file-tree-keyboard.spec.ts` 的 `pressShiftF10ForMenu` 都是这个手法 —— 后者是 Shift+F10 那条键盘入口，焦点把行滚入视区同样会收掉刚弹出的菜单，见 #310）；另注意 `context-menu.spec.ts` 的 beforeEach 故意不调 `closeWorkspace`（会干扰 Teleport 渲染时机）。
   - **动画浮层别用 `waitForRendered` 判「已渲染」**：它把 `opacity: "0"` 判为未渲染，而淡入浮层过渡期就是这个值。右键菜单等浮层用 `waitForPresent`（存在）＋读元素内容断言即可；但 `toast.spec.ts` 那种「先等、**再断言** `isRendered`」的写法是有意为之（断言要求过渡已完成），别顺手统一（#273 实测过，换成 presence 会挂 2 条）。
   - **别用 `isDisplayed()` / `getText()` 读元素**（同一类坑）：`isDisplayed()` 在本栈下会**持久性**误判——实测元素 `display:flex`、`visibility:visible`、`getBoundingClientRect()` 为 138x42、且 store 中确实存在时仍返回 `false`，**重试救不回来**（`smoke.spec.ts` 的 `beforeEach` 为此空等 15s 超时，CI 上随机变红）；`getText()` 则会对某些元素返回 `''`，而它**单次判定不重试**，于是「读太早」直接变成断言失败（`state-display.spec.ts` 曾间歇性挂在这上面）。**判「可见」用 `e2e/helpers/wait.ts` 的 `isRendered`（按选择器）/ `isRenderedElement`（按元素句柄），读文本用 `readText`（按选择器轮询；传 `expected` 即轮询到确切文案）/ `textOfElement`（按元素句柄单次读）**——两类调用点已分别由 #284（`isDisplayed()` 32 处）与 #286（`getText()` 52 处）清扫干净，新代码不要再用这两个 API。浮层仍是上一条的例外：只判「存在」＋读内容。
   - **元素句柄要「等到了再取」**：`browser.$()` 对不存在的元素**不抛错**，返回的句柄 `elementId` 是 undefined，直到拿它去 `browser.execute`（`isRenderedElement` / `textOfElement`）才抛 `The element with selector "..." you are trying to pass into the execute method wasn't found`。所以「先 `const el = await browser.$(sel)` → `waitForPresent(sel)` → 对 `el` 断言」是死路：**等待那一步白做**，首次查询早于渲染就必挂（#320 实测：`file-operations.spec.ts` 的「新建文件」与 `smoke.spec.ts` 的两条欢迎页入口用例各中一处，都是 #284 收尾留下的）。要判「已渲染」就别留旧句柄 —— `waitForRendered` 已改成**每轮重新取句柄**，顺带也吃下 XPath（`//div[...]`）与 `.cls=文本` 这类只有 WebDriver 认的选择器（`isRendered` 走 `document.querySelector`，只吃 CSS）。
   - **判「某个视图已就绪」用存在性，别用几何/可见性**：`v-if` / `v-else` 分支切换时，容器可能有一瞬尺寸为 0，`isRendered`（要求 `rect > 0`）会被误伤 —— `smoke.spec.ts` 的 `beforeEach` 在 CI 上为此偶发 15s 超时（#283、#289 两次命中；换成 `isRendered` 后依旧，见 #290）。此时应判「元素在 DOM 里」（`isExisting` / `waitForPresent`）——`tabs` 为空时 `v-else` 分支保证欢迎页就是当前视图。失败时把「卡在哪一步」带进超时错误，别让 `waitUntil` 只报一句 `timed out`。
   - **session 收尾要把持久化状态清干净（标签会跨 spec 泄漏）**：`closeSession()` 有意不删 `tabs.json`（APPDATA 里的状态交给各 spec 的 `resetPersistenceSettings` 走 Pinia 重置），于是**「开着标签结束」的 spec 会把标签留给下一个 spec** —— 后者启动时 `App.vue` 的 `onMounted` 会 `restore()` 出这批标签，而它的 `beforeEach` 往往又 `resetWorkspace` 把这些**仍处于打开状态**的文件删掉，触发「文件已被外部删除」的模态告警遮住点击（#297 的 CI 失败就是这条路；#300 排查时实测 `editor-preview.spec.ts` 给下一个 spec 留了 3 个 tab）。现由 `closeSession` 统一调 `helpers/store.ts` 的 `clearPersistedTabs()` 收口，**新增 spec 不必再自己写 `afterEach` 清理**；实现上注意 `clearAll()` 只清内存、并且会置 `restoring` 让 Vue watcher 跳过 persist，所以必须**紧接着显式 `persist()`** 落盘，否则 `tabs.json` 里仍是旧内容（等于没清）。将来若要写「标签跨重启存活」的用例，得先绕过这一步。
5. **自查后再合**：合入前跑 `/code-review` skill，把结论贴在 PR 里；有阻断项先修掉。
6. **合入**：**squash merge**（一个 PR = 一个 conventional commit），合入后自动删除头分支。Agent 可自主切分支 / 提交 / 推送 / 开 PR，但**squash 合入 main 前必须得到用户确认**。
7. **main 受保护**：禁止直推、必须 CI 全绿、必须与 main 同步（Require branches to be up to date）；管理员豁免**仅用于紧急修复**；不设 required approving review（单人仓库无法自批自己的 PR）。

**管理员豁免的边界（实测补充）**：实测所见是——豁免会让 *required status checks* 被绕过（用管理员凭据直推 main 会成功，但远端日志里带 `Bypassed rule violations` 警告），而 `allow_force_pushes=false` **不被绕过**：`git push --force-with-lease origin main` 会被 `GH006: Cannot force-push to this branch` 拒掉。其他开关（`allow_deletions` 等）是否被豁免**未实测**，不要假设。

**改写 main 历史是破坏性例外，不是常规手段**（会重写提交哈希，任何引用旧哈希的地方都会失效），仅用于确实要抹掉误提交的情况；动手前先建本地备份分支（`git branch backup/main-<日期> <sha>`）。步骤：① 临时放开 `allow_force_pushes` → ② `git push --force-with-lease origin main` → ③ **无论 ② 成功与否都要**把开关收回。

①③ 是同一条 PUT，把 `allow_force_pushes` 在 `true` / `false` 间切换。照抄下面这条完整命令（别只挑要改的那一项——本次成功的调用是带全 `required_status_checks` / `enforce_admins` / `required_pull_request_reviews` / `restrictions` 与全部开关的）；字段格式有个实测的坑：开关类字段要传**布尔值**，写成 `{"enabled": true}` 会被 422 拒（报错原文 `{"enabled" => true} is not a boolean`）：

```powershell
gh api -X PUT repos/CatInRl/Murasaki/branches/main/protection -F "required_status_checks[strict]=true" -F "required_status_checks[contexts][]=frontend" -F "required_status_checks[contexts][]=rust" -F enforce_admins=false -F required_pull_request_reviews=null -F restrictions=null -F allow_force_pushes=true -F allow_deletions=false -F required_linear_history=false -F required_conversation_resolution=false -F block_creations=false -F lock_branch=false -F allow_fork_syncing=false
```

**与发布衔接**：版本准备单独开一个 `chore(release)` PR（bump `package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` + 写 CHANGELOG），合入 main 后再打 `vX.Y.Z` tag，详见下节「版本节奏与发布约定」。

## Git 提交约定

- 使用 Conventional Commits（中文描述可接受）
- 示例：`feat(editor): 添加滚动同步` / `fix(tabs): 修复关闭逻辑` / `docs: 更新环境指南`
- 不要提交：
  - `.appdata/`（运行时数据）
  - `src-tauri/target/`（构建产物）
  - `node_modules/`
  - `.scratch/`（临时调试脚本）
  - 任何机器特定路径配置

## 版本节奏与发布约定

### 开版本（人工，无自动触发）

1. **建 milestone**：在 GitHub 建一个以目标版本号为标题的 milestone（如 `1.0.0`）。
2. **拆 issue 挂进去**：用 `/to-spec` skill 生成 spec issue 并拆子 issue（见「Issue 跟踪约定」），让它们全部关联到该 milestone。
3. **此时不动版本号**：`main` 上的三处版本号停留在**最近一次发布的版本**，只在 release PR 里改（清单见下「发版本」）。提前 bump 会让每个功能 PR 都变成「要不要改版本号」的无谓冲突源，也让「main 现在是哪个版本」含糊。
4. **功能 PR 照常进 `main`**：CHANGELOG 先累积在 `## [Unreleased]` 段下，发布时再切成 `## [X.Y.Z] - YYYY-MM-DD`。

**依赖升级是否写 CHANGELOG**：**运行期依赖**要记入 `## [Unreleased]`（前端 `dependencies` 与 Rust `Cargo.toml` 的 `[dependencies]`，如 `mermaid` / `vue-i18n` / `sha1`），修安全漏洞的记到 `### Security` 段；**构建期依赖**（前端 `devDependencies` 与 Rust 的 `[dev-dependencies]`，如 `vite` / `vitest` / `vue-tsc` / `@vitejs/plugin-vue`）**不记** —— 它们不改用户可见行为，记进发布说明只会变成噪音。

### 发版本

- **发布流程**：开 `chore(release)` PR 更新三处版本号（package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json），并把 `## [Unreleased]` 段落切成 `## [X.Y.Z] - YYYY-MM-DD` → CI 绿后合入 main → 在 main 打 `vX.Y.Z` tag → 推送 tag 触发 `release.yml` → 关闭 milestone → 同步更新本文件变更记录部分
- **Release 必须包含 CHANGELOG 内容**：`release.yml` 会用 `awk` 从 `CHANGELOG.md` 提取 `## [VERSION]` 段落，拼接到 Release Notes（安装说明 + 变更记录）。因此打 tag 前必须先在 CHANGELOG.md 写好对应版本条目，否则 Release Notes 的"变更记录"章节为空
- **重新发布同版本**：删除旧 release（`gh release delete vX.Y.Z --yes --cleanup-tag`）→ 删除本地 tag（`git tag -d vX.Y.Z`）→ 提交修复代码并推送 → 重新打 tag 并推送触发构建
- **构建产物**：Windows / Ubuntu / macOS arm64 / macOS x64 多平台包，构建约需 10 分钟，进度在 GitHub Actions 页面查看
- **发布后验证**：构建完成后确认 release 产物完整、Release Notes 含 CHANGELOG 内容、CHANGELOG.md 和 AGENTS.md 变更记录已更新

### 不并行

**不引入 `develop` 与 `release/x.y` 维护线**：同一时间只有一条开发线，`main` 就是它（理由与被否决的方案见 [ADR-0019](docs/adr/0019-trunk-based-development-with-pull-requests.md)）。

milestone 可以并存（例如 `0.9.5` 与 `1.0.0` 各挂各的 issue），但**那不等于是两条代码线**。真需要同时维护旧版本时，先改 ADR-0019 再动流程。

## Issue 跟踪约定

- **所有功能/spec 必须有 GitHub issue 跟踪**：用 `/to-spec` skill 生成 spec 并发布到 issue tracker，应用 `ready-for-agent` label
- **任务拆分必须用子 issue 跟踪**：spec issue 创建后，立即用 `gh issue create` 为每个任务创建独立子 issue，标题用 `T{序号} {任务名}` 格式
- **`T{序号}` 只是 spec 内的执行顺序标签**：每个 spec 从 `T1` 重新编号，不跨版本累积；分支名与 PR 标题一律用**真实 issue 号**（如 `docs/205-dev-workflow`），不要用 `T` 编号
- **子 issue body 必含**：实施步骤 / 验收标准 / 依赖关系（引用依赖的 issue 编号）
- **子 issue 关联 spec issue**：在子 issue body 末尾用 `Part of #N` 引用 spec issue，让 GitHub 自动关联
- **spec issue 维护任务清单**：用 GitHub 的 task list 语法 `- [ ] T1 任务名 #N` 列出全部子 issue（不要塞在一条 comment 里）
- **子 issue 挂到版本 milestone**：`gh issue create --milestone <目标版本号>` 挂进该版本的 milestone（开版本的第一个动作，见「版本节奏与发布约定」），发布后由这个 milestone 收口
- **PR 与 issue 关联**：PR body 用 `Closes #N`（该 issue 的活干完）或 `Part of #N`（spec 子任务之一）
- **禁止**：把多个任务塞在一条 comment 里 / 不创建 issue 直接开干 / 用本地 md 文件跟踪任务

## 架构决策

详见 [docs/adr/](docs/adr/)：
- ADR-0001：草稿恢复与 mtime 冲突解决机制
- ADR-0002：选择 Tauri 而非 Electron

## 变更记录

完整 changelog 详见 [CHANGELOG.md](CHANGELOG.md)。版本发布时必须同步更新该文件。

### 当前版本：0.10.2（2026-10-07）

**依赖升级 + Mermaid/预览修复**：Tauri 生态（Rust crate 与 npm 包）升到 2.12，`notify` / `dirs` 各跨一个主版本；修复 HTML 文件演示模式无法缩放及其遗留的分屏模式缩放失效、Mermaid 节点文字超过约 4 行被方框裁切与 gantt 图「今日」标记线毁图；e2e 文件树抖动根因链三层修复（纯测试基建，应用行为零变化）。

- 依赖（#362/#363）：Tauri 生态升 2.12——Rust 侧 `tauri` 2.11.6 → 2.12.0、`wry` 0.55.1 → 0.57.0、`tao` 0.35.3 → 0.37.1，插件同步升级；前端 `@tauri-apps/api` 2.11.1 → 2.12.0 与各插件包对齐，另升 `katex` 0.18.9、`vue-i18n` 11.4.12。Rust 与 npm 的 major/minor 必须一致（Tauri CLI 在 `tauri build` 时校验，不一致报 `Found version mismatched Tauri packages`），故两侧必须同批落地；顺带把 `webview2-com` 钉 0.39 / `windows` 钉 0.62.2 与升版后的 wry 对齐（否则 `pdf.rs` 的 `NavigationCompletedEventHandler` 与 wry 出现两套 `windows` 类型、编译报 `E0277`）；`notify` 7.0.0 → 8.2.0、`dirs` 5.0.1 → 6.0.0
- HTML 演示模式缩放（#405）：HTML 预览是沙箱 iframe，Ctrl+滚轮与键盘事件不跨 iframe 边界冒泡，挂在父文档的缩放监听与快捷键全部收不到、缩放 chip 恒为 100%；现利用 sandbox 既有的 `allow-same-origin` 由父侧在子文档上补挂 wheel / keydown 监听把事件接回（keydown 被消费时把 `defaultPrevented` 同步回传，防 WebView2 浏览器级加速键在 iframe 内照常触发、与应用行为叠加）；挂载用低频轮询幂等完成而非 `@load` 时序——WebKit 系 srcdoc 文档「可交互」早于 load 且初建会先以 about:blank 触发一次 load，轮询同时跳过 about:blank 占位文档并去掉 `loading="lazy"`。附带收益：焦点在 HTML 预览内时 Ctrl+S / Ctrl+P 同样可用（分屏模式同生效）
- 分屏模式缩放生效（#412，#405 遗留）：#405 接通 HTML 预览的事件链路后，分屏模式缩放仍不生效——入口（App.vue `zoomEnabled`）、出口（EditorPane `zoomStyle` / `onWheel`）、StatusBar chip 四处各自按 `editorMode === "presentation"` 判断，分屏下事件虽被接回应用层（不再触发 WebView2 整页缩放）但入口不放行、出口不渲染；抽出 `zoomAppliesTo(mode)`（分屏 + 演示生效，源码 / 所见即所得无预览区不生效）作单一来源统一四处——散落的模式判断只改一处就会复现「入口开、出口关」的状态与内容脱节；设置键与持久化语义不变，e2e 补分屏三快捷键真实过渡 + DPR 守卫（`devicePixelRatio` 不随应用层 zoom 变化，前后不变即证明未整页缩放）
- Mermaid 节点文字裁切（#342 第二症状）：mermaid 按自带行高（16px × 1.5 = 24px）测量节点文本并分配 `foreignObject` 高度，而 `.markdown-body p` 的 1.75 行高（实测 computed 28px）命中其内 `<p>`，实际排版每行多 4px、溢出随行数线性增长、约 4 行起文字被方框裁掉；现以 `.markdown-body .mermaid svg p { line-height: inherit; }` 对齐测量基准，分栏预览 / WYSIWYG / 演示模式三入口同修，新增静态守卫 `mermaidClipGuard.test.ts` 防规则被误删
- Mermaid gantt「今日」线（#342）：今天落在任务时间域之外时 mermaid 11 两种表现都毁图（today 坐标计入 viewBox 把 ~68px 高的图等比压成 ~5px 细线 / today 线画在可视区外而图内文字被裁）；新增 `sanitizeMermaidSvg()` 在每次渲染完成后收敛 SVG——隐藏全部 `g.today`、按根 `getBBox()` 判 today 是否域外（域外保持隐藏、域内恢复显示并并回内容盒）、viewBox 收窄到最终内容盒并同步 inline `max-width`，分栏预览与 WYSIWYG 两渲染入口统一接线，PlantUML 图卡同样受益；gantt 渲染宽度改走 mermaid `useWidth` 官方通道（此前临时容器挂 body 测得 0 宽）；e2e 断言改环境无关三重守卫（viewBox 有效 / 渲染高度 ≥24px / 等比偏差 ≤10%）——CI 英文环境对 CJK 的字体 fallback 与本地中文 Windows 差异巨大，旧宽高比阈值断言把环境差异误判成渲染缺陷
- e2e 抖动根因链（#408，应用行为零变化）：三层叠加一起修——① `list_tree` 顶层读目录失败被静默吞成空树（`build_tree_inner` 改返回 `std::io::Result`，顶层经 `list_tree` 报错、递归子目录保持静默，新增 2 个单测锁语义）；② 上一用例的文件 watcher 仍握测试目录句柄（关闭工作区有意不释放）与下一用例 `resetWorkspace` 删库竞争、Windows 上 `read_dir` 撞句柄冲突（e2e helper `closeWorkspace` 收尾与 `openWorkspace` 开头 best-effort 调 `stop_watching`）；③ `openWorkspace` 吞掉 `executeAsync` 返回值，应用侧失败只剩 `console.error`——而 tauri-driver 会缓存 `console.error` 并在后续每次 execute 时重放为 `WebDriverError` 毒化整个 session（不再吞错，抛错带路径上下文，调 store 前临时消音 `console.error` 完成后恢复）

### 历史版本

- 0.10.1（2026-10-02）：**三平台 e2e + 退出确认 + 一批交互修复**：CI 的 e2e 矩阵扩到三平台（Linux 真实 WebKitGTK 驱动、macOS 应用内嵌 WebDriver 首期只跑不拦）；关闭窗口 / 退出应用时有未保存改动改为三选一汇总确认（不再静默落盘）；修复拖入图片落点、演示模式缩放留白、菜单快捷键提示、视图菜单切换、全屏快捷键与 Linux/macOS 本地图片失图；升级四个运行期依赖清掉 17 条安全告警。

- Linux e2e：CI 新增 `e2e (linux)` job——tauri-driver + WebKitWebDriver（webkit2gtk-driver）驱动真实 WebKitGTK，经 Xvfb 无头运行，与 Windows e2e 共用同一套 spec；Rust `is_e2e_mode()` 增加 Linux 判定通道，e2e harness（进程清理、driver 查找、settings.json 路径、预检脚本）跨平台化。首跑即拦下 spec 里反斜杠拼接路径在 Linux 上产生混合分隔符、应用打不开文件的问题——接收路径的边界现按平台归一化（Windows 原样，其余平台 `\` → `/`）
- macOS e2e：CI 新增 `e2e (macos)` job（首期只跑不拦）——tauri-driver 在 macOS 走 safaridriver 需 GUI 授权不可行，改为应用内嵌 WebDriver 服务端：新增 macOS 运行期依赖 `tauri-plugin-wdio-webdriver` 1.4.0（`cfg(target_os = "macos")` 门控且仅 debug 构建注册，生产 release 无调试端口），harness 直接 spawn debug 二进制并注入 `TAURI_WEBDRIVER_PORT` / `WDIO_EMBEDDED_SERVER`，轮询 `GET /status` 就绪后直连建 session；Windows / Linux 链路不变。收尾修掉 macOS 合成键盘事件不触发 CM6 绑定（`browser.execute` 直派 KeyboardEvent，绕过插件的事件合成路径）与关窗用例误报（容忍 `close_window` 的 IPC 断开）
- 退出确认（#346，[ADR-0017](docs/adr/0017-close-interception-with-draft-flush-on-exit.md) 部分修订）：关闭窗口 / 退出应用时有未保存改动，由静默落盘改为一次三选一汇总确认（全部保存并关闭 / 不保存关闭 / 取消）；选「保存」逐个写回、任一取消或失败即中止退出；多窗口各自询问，无未保存改动不打扰；退出时草稿兜底保留。顺带修正 CONTEXT.md「未命名 tab 下次启动不恢复」的旧说法
- 修复（#344/#337/#341/#340/#338）：拖入图片落点不再整体偏上（wry 在 OLE 回调里已做 `ScreenToClient`，落点本就相对 webview 客户区，删掉装饰偏移只做 DPR 折算，顺带修贴近左上角拖入被判非法坐标静默回退光标）；演示模式放大后预览占满编辑区（`zoom` 下百分比按缩放后的包含块解析，删反向除宽高的重复补偿，逻辑抽为纯函数 `presentationZoomStyle()`）；菜单快捷键提示按平台显示 `Ctrl` / `⌘`（不再原样显示内部 token `CmdOrCtrl`）；视图菜单「文件树视图 / 大纲视图」点击生效（勾选同步传错 ID + 折叠态不展开 + 非 Markdown 静默回退，三处一起修）；`F11` 全屏生效（capability 缺 `core:window:allow-set-fullscreen` 被 ACL 拒、异常又被吞，补权限并改以 `win.isFullscreen()` 为准）
- Linux/macOS 本地图片失图（#339）：DOMPurify 默认 URI 白名单没有 Tauri 的 asset 协议，`asset://localhost/...` 的 `<img src>` 被整个剥掉，预览与 HTML 导出全部失图；现以 `ALLOWED_URI_REGEXP` 放行 `asset:`，data URI（Base64 内嵌）不受影响
- 安全（#353/#354/#355/#356，共清 17 条告警）：`brace-expansion` 2.1.7（4 高危 + 1 中危 DoS：无界展开 OOM / 无控递归栈耗尽等）、`undici` 7.30.0（2 高危 + 5 中危 + 3 低危：TLS 选项克隆丢失、WebSocket 子协议未捕获异常、解压无上限、缓存重放泄 cookie 等）、`markdown-it` 14.3.2（linkify 二次复杂度可阻塞事件循环数十秒）、`dompurify` 3.4.16（afterSanitize 移除节点后残留事件处理器可触发 DOM XSS）

### 历史版本

- 0.10.0（2026-09-29）：**文件打开与拖放体验补全 + 配色单一来源**：拖入窗口即可打开文件 / 文件夹，应用打不开的文件（pdf / zip / exe…）给出兜底出口与拖入提示，图片插入方式可配置，标签栏新增常驻「全部标签」面板；配色收敛为「色阶 → 语义 token」单一来源并让 Mermaid / PlantUML / KaTeX 与 HTML 导出跟随主色，新增 i18n key 与设计 token 两道静态守卫；同时彻底移除自 0.5.0 起就已关闭的 AI Agent 功能，并修掉一批静默失效。

- 打不开的文件有兜底出口（#307/#317/#318）：新增 Rust 命令 `open_with_default_app`（Windows `explorer.exe` / macOS `open` / Linux `xdg-open`，不经 shell）；文件树右键给「用系统默认程序打开」、点击弹说明、拖入时恰好 1 个附同一动作（≥2 个只报计数）；拖入多目录 / 目录与文件混投时提示「已忽略 N 个文件夹（一个窗口只能打开一个工作区）」。取舍与完整打开矩阵写入 [ADR-0020](docs/adr/0020-file-open-strategy-and-fallbacks.md)
- 拖拽打开文件 / 文件夹（#92）：走 Tauri 原生 drag-drop（`onDragDropEvent`）而非 HTML5 拖放（原生事件会拦截系统文件拖放）；恰好一个目录 → 新窗口打开（同目录已在某窗口打开则聚焦），文件逐个在当前窗口开为标签，拖拽经过窗口显示「松开以打开」遮罩
- 图片插入方式可配置（#151）：设置 → 常规新增「图片插入方式」（本地文件 / Base64 内嵌），`Alt` 临时取反，无工作区或落盘失败自动回退内嵌；拖入外部图片插在落点处，文件树内拖入仍是相对路径引用。顺带修「默认图片目录」此前未生效（一直固定写 `<工作区>/assets/`），现按设置落盘并限制为工作区内相对路径
- 全部标签面板（#168）：标签栏右端（「+」左侧）常驻「全部标签」入口 + 计数徽标，弹出可搜索纵向列表（标题 / 所在目录 / 未保存圆点 / 工作区外角标），`↓` / `↑` / `Enter` / `Esc` 键盘可达；命令 `open-all-tabs` 已登记但默认不绑定
- 移除 AI Agent（#264）：自 0.5.0 起由 `AGENT_ENABLED = false` 整体关闭、无任何入口的功能彻底删除（前端引擎 / 右侧面板 / AI 设置分类 / Rust 侧 agent 工具与 provider），运行期依赖 `openai` 与 Rust `reqwest` / `flate2` / `base64` 一并移除；磁盘上既有 secrets / 聊天记录不迁移、不删除
- 配色与设计 token 收敛（#152/#293~#296）：语义 token 改为引用紫色阶 / 中性阶（同一颜色只写一遍）；新增 `--murasaki-primary-soft` / `-soft-hover` / `-ring-soft` 由主色 `color-mix` 派生；Mermaid `themeVariables` 运行时从 token 派生（新增 `src/utils/mermaidTheme.ts`，分栏预览与 WYSIWYG 共用同一初始化入口），PlantUML / KaTeX 与导出 HTML 一并跟随主色；清理 `src/**` 全部指向已定义 token 的死 fallback；新增 `tokenGuard.test.ts`（引用未定义 token 即失败）
- 依赖：`vue-i18n` 9.14.4 → 11.1.11（跨 v10/v11 两个大版本，应用侧无需改动）、`sha1` 0.10 → 0.11（摘要十六进制编码抽为 `commands::sha1_hex()`，输出逐字符不变）、`mermaid` 11.16.0 → 11.16.1（修 [CVE-2026-71438](https://github.com/advisories/GHSA-c4c3-pg64-4m4v) 低危原型污染）
- 修复（#311/#308/#304/#288/#258/#255）：重开同一工作区重新注册文件监听（此前目录句柄失效后不再刷树且无提示）；无后缀文件不再按大小拦截、读不出来时给系统默认程序兜底；按归一化路径（`canonicalPath()`）判定「同一文件」，修重复 tab / 最近列表 / 搜索结果重复项；外部拖入图片改由原生拖放驱动，修 Windows 上失效；导出 HTML 把 asset 协议 URL 回解为本地路径后再内联 Base64；e2e 读 `WEBVIEW2_USER_DATA_FOLDER`，修 msedgedriver 建不了 session
- 静态守卫（#186/#296/#317）：i18n 硬编码 CJK 文案守卫、i18n key 字面量存在性守卫（`i18nKeyGuard.test.ts`）、设计 token 引用守卫

### 历史版本

- 0.9.0（2026-09-25）：**易用性提升 + 多窗口改造**：新增只读演示模式（第 4 种显示模式）与缩放，状态栏字数/字符数并存与显示模式下拉，显示模式与加粗/斜体快捷键，视图菜单重构，退出时静默落盘，文件树与右键菜单键盘可达、外部结构变更自动刷新；并把应用从「单窗口 + 单工作区」改造为**多窗口 = 多工作区**——外部入口（双击文件关联 / 命令行传文件 / 拖到任务栏）一律**新开窗口且不恢复上次工作区与标签**；「打开文件夹」总是新开窗口（同一文件夹已在某窗口打开则聚焦那个窗口）；每个窗口各自静默落盘、**关掉最后一个窗口才退出应用**；并去掉「打开单个文件自动把所在目录设为工作区」的隐式副作用；同时修复批量关闭标签丢内容、打开文件对话框类型受限与欢迎页版本号过期。

- 多窗口基础设施（#194/#195）：新增 [commands/windows.rs](src-tauri/src/commands/windows.rs)（`WindowRegistry` 窗口↔工作区注册表 + `next_label`/`set_workspace`/`window_for_workspace`/`begin_exit`，路径归一化比较支撑「同目录聚焦」）与 `src/utils/windowContext.ts`（`currentWindowLabel`/`isMainWindow`/`tabsStoreKey`）；新增命令 `open_path_in_new_window` / `set_window_workspace` / `close_window`；`exit_if_no_other_windows` 由 `close_window` 与 `Destroyed` 双向兜底。详见 [ADR-0018](docs/adr/0018-multi-window-multi-workspace.md)
- 进程级状态按窗口分片（#194/#196~#199）：`WatcherState` 改 `HashMap<label, WatcherEntry>`（原 `*guard = Some(watcher)` 会顶掉前一个窗口的监听）；`PendingOpenState` 改按 label 分槽；`ClosingState` 改 `HashSet<label>`；`RecentMenuState` 新增 `window_ui: HashMap<label, WindowUiState>` + `active_window_label` / `apply_checked_for_window`，勾选命令 `set_theme_checked`/`set_mode_checked`/`set_sidebar_view_checked` 改带 `window` 参数按窗口存储、非焦点窗口不抢菜单显示
- 事件改定向发送：`app-close-requested` / `menu-event` / `recent-open` / `navigate` / `file-changed` 全部 `emit_to(label)`，前端监听器同步改 `getCurrentWebviewWindow().listen`——Tauri 的 `Emitter::emit` 是**广播到所有 webview**（多窗口下广播会让所有窗口一起关窗或重复执行同一命令），而裸 `listen` 的 target 是 `Any`，`match_any_or_filter` 让 Any 监听器匹配**一切** emit（含定向 `emit_to`），任一端退化都等于广播
- 外部入口改建窗（#194/#202）：single-instance 回调改为有路径即 `open_path_in_new_window_impl`（失败才聚焦活动窗口），冷启动 argv 仍写 `PendingOpenState` 的 `main` 槽；前端删除 `single-instance-open-workspace` / `open-from-argv` 两个推送型监听器，`App.vue` 把 `take_pending_open_path` **提前到会话恢复之前**，取到路径即**跳过** `lastWorkspacePath` 恢复与 `tabsStore.restore()`
- 关闭语义（#194/#198）：`intercept_close_request` 去掉 `label == "main"` 判断（所有编辑器窗口都拦），新增 `quit_app` 通知所有窗口各自落盘后由最后一个窗口退出；`useExitFlush` 的 `exit_app` → `close_window`，`useCommands` 的 `quit` → `quit_app`
- 打开文件夹/最近文件夹（#194/#201）：`useWorkspaceStore.openFolderDialog` 改为选目录后 `open_path_in_new_window`，不再调 `openWorkspace`（四个入口共用）；`useFileActions.openFile` 删除「无工作区自动以文件所在目录为工作区」；新增三语 `common.openFolderTitle`
- 持久化分 key（#194/#200）：`tabs.json` 主窗口沿用旧 key `state`（零迁移）、其它窗口 `state:<label>`；`lastWorkspacePath` 只由主窗口写回；`settings.json` / `recent.json` 保持全局共享
- 修复：`WindowUiState.sidebar_view` 存视图名（`files`/`outline`）而勾选需要菜单项 ID，焦点重放时比较对象不一致导致两组勾选全空；新增 `sidebar_menu_id()` 统一转换
- 自测修复（#194，0.9.0 端到端自测 71/71 过程中定位）：① capability `windows` 由 `["main","settings"]` 改 `["*"]`——运行时动态创建的 `win-N` 不在白名单就**一条插件命令都不许调**（含 `plugin:event|listen`），前端挂在注册监听器上，既收不到 `app-close-requested`（窗口关不掉）也走不到消费待打开路径；② `open_path_in_new_window` 改 `async`——Tauri 同步命令在**主线程**执行，建窗要投递 `Message::CreateWindow`，`send_user_message` 发现已在主线程就**内联执行**，等于在 WebView2 IPC 回调里同步创建新 WebView2 环境，实测死锁；③ 前端 `app-close-requested` / `menu-event` / `recent-open` / `navigate` / `file-changed` 监听器统一改 `getCurrentWebviewWindow().listen`——裸 `listen` 的 target 是 `Any`，而 `match_any_or_filter` 让 Any 匹配一切 emit，定向 `emit_to(label)` 被退化为广播，关一个窗口会连带关掉全部窗口；④ capability 补 `core:window:allow-close` / `allow-destroy`——`core:window:default` **不含**这两项，缺了则 `useExitFlush` 的兜底销毁会被 ACL 拒绝（`Command plugin:window|close not allowed by ACL`），退出落盘失败时窗口关不掉
- 验证：`cargo test` 90 passed（新增 `window_ui` 分片、`sidebar_menu_id`、`WindowRegistry`、pending 分槽、`ClosingState` 按窗口等单测）、`npm test` 1028 passed、`npm run build` 通过；0.9.0 端到端自测 **71/71 通过**（含真实 single-instance 外部入口多窗口链路：第二实例传文件 → 新开窗口 → 关该窗口后主窗口与进程存活 → 关最后一个窗口才退出）

- 演示模式（#180/#181）：新增 `presentation` 模式，只挂预览不挂编辑器（铺满、无工具栏与分隔条），只读；内部 `.md` 链接开新 tab、外部链接走系统浏览器、任务列表 checkbox 只读；缩放 50%–200% 步进 10%（`Ctrl+=`/`Ctrl+-`/`Ctrl+0` + 按住 Ctrl 滚轮，`EditorPane` 的 `onWheel` 拦截 WebView2 默认缩放），持久化 `settings.presentationZoom`，缩放逻辑抽为纯函数 `src/utils/presentationZoom.ts`
- 状态栏（#182/#187）：字数（CJK 逐字 + 拉丁分词）与字符数（不含空白）并存；新增显示模式 chip，点击弹出四项下拉（不再循环切换）、演示模式缩放 chip 可点击复位；统计逻辑抽为纯函数 `src/utils/textStats.ts`
- 快捷键（#183/#187）：`Ctrl+Shift+1/2/3/4` 切换 源码/分屏/所见即所得/演示；`Ctrl+B`/`Ctrl+I` 加粗/斜体（仅 markdown，编辑器作用域）；冲突检测按 `global`/`editor` 作用域隔离；新增 `SHIFT_BASE_KEYS` 反查表修上档组合（`Ctrl+Shift+1` 实际 `e.key === "!"`）匹配
- 视图菜单重构（#184）：视图前移到「主题」之前，含「显示模式 ▸」二级子菜单（四态 CheckMenuItem 互斥）+ 文件树视图/大纲视图（互斥勾选）+ 状态栏 + 全屏；勾选遍历改为递归 `set_checked_by_ids`，新增 `set_sidebar_view_checked` 命令
- 退出静默落盘（#185/#194）：Rust `on_window_event(CloseRequested)` + `prevent_close()` 拦截（`ClosingState(HashSet<label>)` 按窗口防重入），前端落盘脏 tab 草稿与状态后调 `close_window`，含 3s 超时兜底；未命名 tab 不落盘不提示。详见 [ADR-0017](docs/adr/0017-close-interception-with-draft-flush-on-exit.md)
- i18n 守卫（#186）：新增 `src/locales/i18nHardcodedGuard.test.ts`，扫描 `dialog.*`/`toast.*` 调用实参中的 CJK 字符，出现即测试失败；同步修 16 处硬编码并补三语 key
- 显示模式作用域：全局默认 + 按文件类型记忆（markdown 沿用最后一次，source-only 强制源码，不按单文件记忆）
- P0 修复（#177/#178/#179）：批量关闭只弹一次汇总确认；打开文件三级过滤器；欢迎页/关于运行时读取版本号
- 文件树键盘可达（#189/#190/#191）：文件树改标准 ARIA tree（`role="tree"`/`treeitem` + roving tabindex + `↑↓←→`/`Home`/`End`/`Enter`/`Space`/`Shift+F10`），扁平化与焦点纯函数在 `src/utils/treeNavigation.ts`；空白区右键统一走 `ContextMenuContainer`（`useFileOpsStore.hasClipboard` 控置灰）；右键菜单补 `↑↓`/`Home`/`End`/`Enter`/`Esc` 与焦点归还，欢迎页最近列表改真 `<button>`
- 菜单「新建文件夹」（#188）：有工作区时改走文件树根目录内联命名，删除 `newFolderPrompt`/`newFolderPlaceholder`/`createFolderFailed` 三语 key
- 文档对齐（#192）：CONTEXT.md 主题补 Murasaki 共五套、补键盘导航章节、打开文件无工作区改为「自动以所在目录为工作区」（该行为已在 #194 移除，文档随之回改为「不再自动设工作区」）；spec.md Out of Scope 删已上线四项、主题改五套；README 主题列表同步

### 历史版本

- 0.8.5（2026-09-24）：**修复冷启动打开文件、启动恢复体验与 WYSIWYG 编辑态**：应用未运行时双击 `.md` 文件现在能正确打开目标文件；启动恢复上次 tabs 时不再逐个文件切换；所见即所得模式下编辑态范围收窄到光标所在行/块，全选时自带背景的块级部件也有选中反馈。

- 冷启动文件关联（#92/#113）：废弃 Rust 侧"延时 800ms 推 `open-from-argv` 事件"（前端注册监听器晚于该延时会丢事件，表现为只恢复旧 tabs），改为拉取模型——`setup` 把 argv 路径暂存到新增的 `PendingOpenState`（[commands/launch.rs](src-tauri/src/commands/launch.rs)），前端初始化完成后调用 `take_pending_open_path` 取走并复用 `onOpenPath`；`classify_path` / `first_non_flag_arg` 一并收敛到 launch.rs，单实例（应用已运行）仍走事件推送
- 启动 tabs 恢复：`openFile` / `newTab` 新增 `activate` 选项，`restore()` 全部以 `activate: false` 装载、最后一次性激活目标 tab，避免编辑器随 `tabId` 变化反复整体替换 EditorState
- WYSIWYG 编辑态范围：新增 `getCursorLineRange`（行内标记按光标所在行判定，替代整段判定，修相邻行误翻源码）；新增 `startsBlockLine` 并让 `getParagraphRange` 在会中断段落的块级起始行截断（围栏/ATX 标题/引用/列表项/分隔线/HTML 块起始），修光标进代码块后上方段落误翻源码；光标在代码块内时整个块为激活范围，围栏 CodeMark 保持 dim
- WYSIWYG 全选视觉：代码块（Shiki pre）/图表卡片/预览卡/表格/frontmatter 等自带不透明背景的块级部件，用 `::after` 半透明紫覆盖层显示选中态（`pointer-events: none`，不设 z-index，供锚点胶囊与工具条保持上层）
- WYSIWYG 表格提交：失焦/Esc 提交前判重，reflow 后源码与文档原文一致则跳过 dispatch，避免未改动的进出表格把文件标记为待保存

### 历史版本

- 0.8.4（2026-09-03）：**显示模式改由菜单切换、编辑时大纲实时更新、WYSIWYG 表格编辑增强**：显示模式不再在设置中配置，改由菜单栏「视图 / 显示模式」互斥切换；编辑器中未保存新增内容实时反映到大纲；所见即所得表格支持方向键导航、表头编辑与贴合上方的居中工具条。

- 显示模式菜单（#147）：新增「视图」子菜单（源码/分屏/所见即所得，CheckMenuItem 互斥勾选），`set_mode_checked` 命令同步菜单与状态；移除设置面板编辑模式配置，三语言菜单文案同步
- 大纲实时更新（#170）：Rust 新增 `parse_outline_str`（单一解析源，无磁盘/mtime）；前端 `useOutline.updateLiveText` 200ms 防抖 + 序列号防回跳；Sidebar 仅大纲视图可见时按 `activeContent` 刷新；移除未用的保存后 `refresh()`
- WYSIWYG 表格：方向键导航、表头编辑、删除边界约束、结构化操作前同步 DOM、工具条贴合表格并置中

### 历史版本

- 0.8.3（2026-08-29）：macOS 快捷键原生适配（统一 `CmdOrCtrl` 显示 ⌘）与全选视觉修复（块级部件选中高亮）
- 0.8.1（2026-08-24）：0.8.0 体验优化与修复——中文符号转 Markdown 记号支持空格/回车双触发、围栏代码块内可输入闭合 ` ``` `；修复 WYSIWYG 引用块行高不足导致内容显示不全
- 0.8.0（2026-08-24）：中文输入与导航体验——中文符号自动转 Markdown 记号、快捷键自定义、统一全局搜索条取代跨文件搜索面板、Tab 栏区分工作区内外文件、多语言支持扩展（新增日语）；【0.8.0 重发】修复 build.rs 误删 `tauri_build::build()` 导致 Windows 包启动报 TaskDialogIndirect、release.yml 未传 releaseBody 导致更新弹窗「无发布说明」
- 0.7.1（2026-08-19）：HTML 文件体验修复（源码左侧可编辑、分隔条拖拽跨 iframe 修复）
- 0.7.0（2026-08-19）：用户体验改进（WYSIWYG 表格对齐与图表实时预览、阅读字体四档预设、非 Markdown 文件支持、文件树宽度调整与折叠、新建文件内联命名）
- 0.6.0（2026-08-11）：PlantUML 图渲染支持（官方纯浏览器方案，TeaVM 产物本地渲染 SVG，懒加载不拖慢启动）
- 0.5.0（2026-08-04）：所见即所得模式可用性（样式统一 + 模式切换 + 本地图片 + 大纲跳转 + 任务列表 + 自动更新打通）
- 0.4.0（2026-08-03）：产品交付能力（自动更新管道 + 三种导出格式 + 国际化框架 + 搜索重构 + AI Provider 抽象 + WYSIWYG 四项补全）
- 0.3.0（2026-07-30）：整体 UX 对齐 + WYSIWYG 模式（设计系统 + 反馈系统 + 状态展示三兄弟 + WYSIWYG + 设置窗口 + Markdown 样式统一 + Agent 面板对齐）
- 0.2.0（2026-07-29）：Agent 能力（OpenAI 兼容端点 BYOK 助手 + 流式输出 + 提案 + 对话持久化 + 三层上下文压缩）
- 0.1.0（2026-07-23）：首个正式版本（工作区 + 文件树 + 多 tab + CM6 编辑 + 实时预览 + 跨文件搜索 + HTML 导出）

## 需要帮助时

- 环境问题 → 先读 [docs/development-setup.md](docs/development-setup.md)
- 产品行为问题 → 读 [docs/spec.md](docs/spec.md)
- 项目术语 → 读 [CONTEXT.md](CONTEXT.md)
- 历史决策 → 读 [docs/adr/](docs/adr/)
