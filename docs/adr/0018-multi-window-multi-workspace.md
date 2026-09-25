# ADR 0018: 多窗口 = 多工作区

## 状态

已接受

## 背景

0.9.0 之前，Murasaki 是**单窗口 + 单工作区**模型，且「打开单个文件」有一条隐式副作用：

- `useFileActions.openFile()` 在无工作区时**自动把文件所在目录设为工作区**（早期版本引入，issue #96/#113）；
- Rust 侧四个全局单例都假设「只有一个窗口」：
  - `WatcherState` 用单槽 `*guard = Some(watcher)`，第二个工作区直接**顶掉**第一个的监听；
  - `ClosingState` 是单 `AtomicBool`，且只认 `window.label() == "main"`；
  - `PendingOpenState` 是单槽 `Mutex<Option<String>>`；
  - `RecentMenuState` 的 `current_theme/current_mode/current_sidebar_view` 是全局值，多窗口会互相覆盖勾选。
- `on_menu_event` 全部 `emit` 到固定 `main` 窗口。

用户提出的两个需求：

1. 打开单个文件时**不恢复工作区**，而且**新开窗口**；
2. 支持**多个工作区同时打开**。

讨论中确认了一个关键事实：**每个 Tauri 窗口是独立 WebView，前端 Pinia 状态天然按窗口隔离**，因此「多工作区」不需要改造 store 结构，只需要把 Rust 侧的进程级状态按窗口分片、并把「打开文件夹」的路由改成新窗口。

## 决策

**多工作区 = 多窗口**。一个窗口 = 一个工作区 = 一份独立的前端会话。

1. **入口分流**
   - **外部入口**（双击 `.md` 文件关联 / 拖到任务栏图标 / 命令行传文件）→ **新开窗口**，且该窗口**不带工作区**，只打开传进来的文件。启动时若有待打开路径，则**跳过**上次会话（工作区 + 标签）恢复。
   - **「打开文件夹」→ 总是新开窗口**；若该文件夹已在某窗口打开，则**聚焦那个窗口**，不重复开窗（避免同目录双 watcher 与文件写入冲突）。
   - 应用内 `Ctrl+O` 与「最近文件」中的**文件**仍在**当前窗口**开标签，不动当前工作区。
2. **去掉「打开单文件自动设工作区」**：删除 `openFile()` 里的隐式 `openWorkspace(dirname(path))`。这条副作用正是「点开一个文件，工作区被悄悄换掉」的来源，与多窗口语义冲突。
3. **Rust 侧进程级状态全部按窗口 label 分片**
   - `WindowRegistry`（新建 [windows.rs](../../src-tauri/src/commands/windows.rs)）：`label → 工作区根路径` 注册表 + 窗口 label 计数器 + 退出防重入标志。`window_for_workspace()` 做路径归一化（`\`→`/`、去尾斜杠、Windows 小写化）后比较，支撑「同目录聚焦」。
   - `WatcherState`：`HashMap<label, WatcherEntry>`，每个窗口各持一个 `notify` watcher（RAII，drop 即停），互不顶替。
   - `PendingOpenState`：`HashMap<label, String>`，路径按目标窗口分槽，前端只取自己那槽。
   - `ClosingState`：`HashSet<label>`，每个窗口各自只允许进入一次「拦截 → 落盘 → 关窗」流程。
   - `RecentMenuState`：全局部分（最近列表 / 语言 / 快捷键覆盖）保留共享，勾选状态拆到 `window_ui: HashMap<label, WindowUiState>`。
4. **路径传递沿用「拉取模型」**：新窗口创建时把路径写入该 label 的 pending 槽，前端挂载完成后主动 `take_pending_open_path` 取走。**不能用延时 `emit`**——前端初始化耗时不确定，事件会在监听器注册前发出而丢失（issue #113 的教训）。取到路径即视为「外部入口创建的干净窗口」，跳过会话恢复。
5. **关闭语义去掉「主窗口」特权**：所有编辑器窗口都拦截 `CloseRequested`，各自静默落盘（草稿 + 本窗口的 `tabs.json` 槽）后调 `close_window` 关掉自己；**关掉最后一个窗口才退出应用**。菜单「退出」改为 `quit_app`，通知所有窗口各自落盘。
6. **必须用 `emit_to` 而不是 `emit`**：Tauri 的 `Emitter::emit` 是**广播到所有 webview**。多窗口下广播 `app-close-requested` 会让所有窗口一起关，广播 `menu-event` 会让两个窗口各执行一次同一命令。所有「本该只给某个窗口」的事件（`app-close-requested` / `menu-event` / `recent-open` / `navigate`）一律 `emit_to(label)`。
7. **持久化按窗口分 key**：`settings.json` / `recent.json` 保持全局共享（符合预期）；`tabs.json` 改为主窗口沿用旧 key `state`（零迁移）、其它窗口用 `state:<label>`。`lastWorkspacePath` 只由主窗口写回，避免多窗口互相覆盖。

## 理由

1. **窗口即隔离边界** —— Tauri 每个窗口一个 WebView 一个 JS 上下文，前端 store 天然隔离；把 Rust 侧状态也按 label 分片后，「多工作区」不需要引入任何跨窗口协调协议。
2. **「打开文件夹 = 新窗口」是唯一自洽的多工作区交互** —— 若在同一窗口切换工作区，必然要清空当前标签或让标签跨工作区漂移，两者都会丢掉用户上下文。
3. **同目录聚焦而非重复开窗** —— 同目录两个 watcher 会对同一批文件产生双份事件，拖拽 / 粘贴等写操作也会互相干扰；聚焦既有窗口成本最低且符合直觉。
4. **单文件不设工作区** —— 双击一个文件时用户意图是「看这个文件」，不是「把这个目录变成我的工作区」。旧行为会让「最近文件」里点一个 `.md` 就把精心组织的工作区换掉，是明确的错误。
5. **拉取模型而非推送** —— 见上 §4；这是 issue #113 已经踩过的坑，冷启动路径必须复用结论。

## 备选方案

**单窗口内多根工作区（多 root 侧栏）** —— 被否决：需要重写侧栏树、大纲、搜索、watcher 全套以支持多根，成本远高于多窗口；且跨 root 拖拽 / 搜索合并会带来大量边界问题。列为 Out of Scope。

**同一窗口切换工作区（清空旧标签）** —— 被否决：丢用户上下文，且与「同时打开多个工作区」的诉求直接矛盾。

**新窗口也恢复上次工作区 + 标签** —— 被否决：双击文件的窗口里出现上次的整套标签，正是用户抱怨的「恢复工作区」问题。

**`settings.json` 也按窗口隔离** —— 被否决：主题 / 字体 / 快捷键是应用级偏好，按窗口隔离只会让用户困惑。

**保留 `main` 作为特殊窗口（只有它能恢复会话、只有它退出应用）** —— 被否决：多窗口下「谁先被关掉」不确定，主窗口一关就退出会让别的窗口的未保存内容一起消失；改为「关最后一个才退出」跨平台一致且无需主窗口概念。

## 后果

**正面**

- 多工作区并行：两个窗口各自文件树 / 大纲 / 外部变更监听互不干扰。
- 双击文件不再污染当前工作区；外部入口一律干净窗口。
- 关闭任一窗口只影响该窗口，未保存内容仍静默落盘。
- 主窗口 `tabs.json` key 未变，老用户升级后会话恢复行为不变。

**负面**

- 窗口数量无上限：每个窗口一个 watcher + 一份 WebView 内存，开很多窗口会占内存（依赖用户自觉，未加限制）。
- 非主窗口的 `tabs.json` 槽（`state:win-N`）写进去后不会被恢复，属于冗余数据（保留是因为决策 ③ 要求「各窗口各自落盘」；若将来要恢复多窗口会话可直接复用）。
- `window_ui` 随窗口数增长，需要 `Destroyed` 事件清理（已实现于 `cleanup_window_state`）。
- 「窗口 → 工作区」注册表在前端上报前的短暂窗口期内靠建窗时的**预留登记**兜底，若建窗后前端迟迟不加载，注册表里会留一条没有实际工作区的记录（窗口销毁时清理）。

## 实施边界

### 文件改动

- 新建 `src-tauri/src/commands/windows.rs`（`WindowRegistry` + `create_editor_window` + `open_path_in_new_window` / `set_window_workspace` / `close_window` / `cleanup_window_state` / `exit_if_no_other_windows`）、`src/utils/windowContext.ts`（窗口 label / tabs key 派生）。
- 改 Rust：`launch.rs`（pending 分槽）、`watcher.rs`（按窗口 watcher）、`lifecycle.rs`（`ClosingState` 按窗口 + `quit_app`）、`menu.rs`（`window_ui` + `apply_checked_for_window` + 勾选命令带 `window` 参数）、`settings.rs`（设置页路由到活动窗口）、`lib.rs`（单实例回调改建窗、`on_window_event` 的 `Focused`/`Destroyed` 分支、命令注册、`emit_to`）。
- 改前端：`useAppLifecycle.ts`（工作区上报 + 删除 `single-instance-open-workspace` / `open-from-argv` 两个监听器）、`usePersistenceStore.ts`（tabs 分 key）、`useFileActions.ts` / `useWorkspaceStore.ts`（去自动设工作区、打开文件夹走新窗口）、`useExitFlush.ts`（`exit_app` → `close_window`）、`useCommands.ts`（`quit` → `quit_app`）、`App.vue`（提前 `take_pending_open_path` 并据此门控会话恢复）、三语 `common.json`（`openFolderTitle`）。
- 文档：本 ADR、`CHANGELOG.md`、`AGENTS.md`、`CONTEXT.md`、`docs/spec.md`。

### 测试

- Rust：`WindowRegistry` 的 label 分配 / 工作区登记 / 归一化命中与不命中 / 清理 / 只退出一次；`PendingOpenState` 分槽互不干扰；`ClosingState` 按窗口互不干扰；`RecentMenuState` 的 `window_ui` 分片与 `sidebar_menu_id` 映射（`cargo test` 90 passed）。
- 前端：`useAppLifecycle.test.ts` 断言只注册 4 个监听器且不含已删的两个；`useFileActions.test.ts` 的 deps 收敛。`npm test` 全绿、`npm run build` 通过。

### 范围外

- 单窗口内多根工作区（多 root 侧栏）。
- 窗口间拖拽标签 / 标签跨窗口移动。
- 窗口布局（位置 / 尺寸）持久化与恢复。
- `settings.json` 按窗口隔离。
- 把文件拖到**窗口内容区**打开（此前未实现；拖到任务栏图标走 single-instance argv，已随本 ADR 支持）。
