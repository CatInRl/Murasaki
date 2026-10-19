# AGENTS.md

> **本文件是 AI 助手（Claude / Codex / 其他）在新会话开始时必读的入口文档。**
> 它汇总了本项目的关键约定，避免每次会话重新踩坑。

## 项目概览

- **Murasaki** — 基于 Tauri 2.x + Vue 3 的桌面 Markdown 编辑器
- 仓库：https://github.com/CatInRl/Murasaki
- 详细产品规格见 [docs/spec.md](docs/spec.md)（**历史规格，停在 0.9.x 基线**，现行行为以 CONTEXT.md 与 CHANGELOG.md 为准）
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

7. **终端通道的绕行方式**：直接 `RunCommand` 可能被 Toolhost 拒绝（报 `Toolhost terminal commands must be routed through the agent runtime`）。此时改用 `integrated_code_mode` 的 `Exec`，在其中 `await tools.Shell({ command, cwd })`，效果等同。
   - 给子代理做 diff 评审时，先由主代理把 `git diff <base>` 落成临时文件（如 `%TEMP%\review-<pr>.diff`），再让子代理 `Read` 该文件——子代理通常拿不到可用的 shell。

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
| `npm run test:coverage` | 单元测试 + 覆盖率阈值（CI 门禁用） |
| `npm run lint` | ESLint 静态检查（含 e2e） |
| `npm run format:check` | Prettier 格式检查 |
| `npm run typecheck:e2e` | e2e TypeScript 类型检查（`tsc -p e2e`） |
| `npm run test:rust` | Rust 测试（CI 另跑 `cargo fmt --check` 与 `cargo clippy -D warnings`） |
| `npm run test:e2e` | E2E（真实 WebView2；需先构建 + 装 tauri-driver/msedgedriver） |
| `npm run build` | 仅构建前端（vue-tsc + vite build） |

## 开发流程

**分支模型**：`main` 恒为可发布状态，所有改动经短生命周期分支 + PR 合入（详见 [ADR-0019](docs/adr/0019-trunk-based-development-with-pull-requests.md)）。**不引入 develop / release 分支**。

1. **先有 issue**：任何改动都要有 issue 跟踪（见下「Issue 跟踪约定」），禁止无 issue 开工。
2. **切分支**：从最新 `main` 切出 `<type>/<issue>-<slug>`，例如 `fix/198-multi-window-deadlock`、`docs/205-dev-workflow`。`<type>` 取 Conventional Commits 类型（feat / fix / docs / refactor / test / chore）。分支名必须带 issue 号，所以**先有 issue 才有分支**。**不要在 main 上直接提交**。
3. **开 PR**：推送分支后开 PR，标题格式 `<type>(<scope>): <描述> (#<issue>)`，描述按 [.github/pull_request_template.md](.github/pull_request_template.md) 模板填写（dependabot 等机器人开的 PR 不受此标题格式约束）。
4. **过门禁**：[.github/workflows/test.yml](.github/workflows/test.yml) 中 `frontend`、`rust` 与 **12 个 e2e 分片 job** 必须全绿——
   - `frontend`（ubuntu-24.04）：`npm test` + `npm run build`
   - `rust`（windows-latest）：`npm run build` + `npm run test:rust`（`tauri.conf.json` 的 `frontendDist` 指向 `../dist`，需先产出 dist）
   - `e2e (n/4)` / `e2e (linux) (n/4)` / `e2e (macos) (n/4)`（n=1..4）：三平台各自切 4 片并行（#444）。Windows 用 tauri-driver + msedgedriver 驱动**真实 WebView2**，Linux 用 WebKitWebDriver + Xvfb，macOS 用应用内嵌的 WebDriver 服务端；均跑 `npx tauri build --no-bundle` + `npm run test:e2e`

   `e2e` 于 **2026-09-26 提升为必过项**（此前只跑不拦，见 #261；提升的依据是修掉三类 flake 后连续 4 次跑绿：应用就绪未等 #266、元素等待不重试 #268、只等容器不等节点 #270。提升后它的第一次运行就拦下第四类 flake —— 右键菜单被滚动收起，见 #273）。**2026-10-19 起分片**（#444）：瓶颈是每个 spec 启动一次真实 WebView（Linux ≈30s × 41 文件 ≈ 20 分钟），4 片后 Linux 从 **39 分钟降到约 12 分钟**、Windows/macOS 约 7 分钟。CI 分钟总数不变，只是并行度提高。若某次确认是环境抖动而非回归，可 `gh run rerun <run-id> --failed` 重试，确需临时降级时改分支保护的 required status checks（`gh api repos/CatInRl/Murasaki/branches/main/protection/required_status_checks -X PATCH ...`）。

   **e2e 分片怎么改**：分组表在 `e2e/vitest.config.ts` 的 `SHARD_GROUPS`，CI 传 `E2E_SHARD=<序号>/<总数>` 选片；本地不设该变量时跑全集。两条硬约束：
   - **新增 spec 文件必须加进 `SHARD_GROUPS`**，否则它在 CI 上**永远不跑且没有任何提示**（配置里有自检会直接报错，别把它当噪音删掉）。
   - **改分片数必须同步改分支保护的 required checks**：job 名是 `e2e (2/4)` 这种格式，数字变了旧名就永远 pending。过渡期可以先把「旧名 + 新名」都放进保护（只增不减），等分片 PR 合入后再把旧名删掉；反过来（直接只留新名）会让**任何基于旧 workflow 的在途 PR 全部卡死**。
   - 不要用 Vitest 内置 `--shard`：它按文件数均分、不看每文件用例数，实测让 wysiwyg-full（79 条）与一堆小文件混在一起，最重的一片仍决定总时长。

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
  - 打 tag 前可本地自检版本一致性：`TAG=vX.Y.Z node scripts/check-release-ready.mjs`
  - `release.yml` 会先校验「tag 与三处版本号一致」并等该提交的 frontend / rust 与 12 个 e2e 分片 job（`e2e (n/4)` / `e2e (linux) (n/4)` / `e2e (macos) (n/4)`，见「过门禁」）全绿；任何一项不满足都会拒绝发布
  - Release 先以**草稿**创建，四个平台产物与 `latest.json` 齐全后才自动转正；中途失败时保持草稿，便于排查后重跑
- **Release 必须包含 CHANGELOG 内容**：`release.yml` 会用 `awk` 从 `CHANGELOG.md` 提取 `## [VERSION]` 段落，拼接到 Release Notes（安装说明 + 变更记录）。因此打 tag 前必须先在 CHANGELOG.md 写好对应版本条目，否则 Release Notes 的"变更记录"章节为空
- **重新发布同版本**：删除旧 release（`gh release delete vX.Y.Z --yes --cleanup-tag`）→ 删除本地 tag（`git tag -d vX.Y.Z`）→ 提交修复代码并推送 → 重新打 tag 并推送触发构建
- **构建产物**：Windows / Ubuntu / macOS arm64 / macOS x64 多平台包，构建约需 10 分钟，进度在 GitHub Actions 页面查看
- **发布后验证**：构建完成后确认 release 产物完整、Release Notes 含 CHANGELOG 内容、CHANGELOG.md 和 AGENTS.md 变更记录已更新

### CHANGELOG 编写约定

CHANGELOG 的读者是**人**（用户与维护者），不是实现细节的档案。要求：

- 遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，按 Added / Changed / Fixed / Removed / Security 分类。
- 每个版本开头写 1–2 句**版本摘要**：这个版本改了什么、对用户意味着什么。
- 每条变更一句话讲清**用户可感知的行为变化**；动机 / 影响只在有助于理解时补半句。
- **不写**：根因分析、实现机制、文件名 / 函数名 / 变量名 / 内部命令名、测试与 CI 细节、大段技术论证与调试过程——这些属于 PR 描述、issue 或 ADR，不属于 CHANGELOG。
- 保留 issue 号 `(#NNN)` 便于溯源；确有价值时保留 ADR 链接。
- 面向**用户**而非开发者：不面向用户的纯内部改动（测试基建、重构、构建脚本）默认不记，确属发布重点时最多一句话带过。
- 同一份内容会同时用于 GitHub Release Notes 与应用内更新说明（见上「发版本」），更需要精简。

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

### 当前版本：0.11.0（2026-10-19）

质量与性能整改：补上错误提示、安全边界与发布门禁；光标与滚动位置现在可跨重启恢复，打开多标签更省内存、长文编辑更少卡顿（详见 [CHANGELOG.md](CHANGELOG.md)）。

## 需要帮助时

- 环境问题 → 先读 [docs/development-setup.md](docs/development-setup.md)
- 产品行为问题 → 读 [docs/spec.md](docs/spec.md)
- 项目术语 → 读 [CONTEXT.md](CONTEXT.md)
- 历史决策 → 读 [docs/adr/](docs/adr/)
