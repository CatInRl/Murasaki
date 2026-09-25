# ADR 0017: 退出前拦截与草稿落盘

## 状态

已接受

## 背景

0.9.0 易用性提升（issue #176 / 子任务 #185）之前，退出应用不检查未保存改动：

- 前端 `quit` 命令只调 `getCurrentWebviewWindow().close()`；
- Rust 侧没有 `on_window_event(CloseRequested)` 拦截，窗口直接销毁；
- WebView 卸载时也没有 `beforeunload` 兜底。

结果是：已命名文件的未保存修改只能依赖 [ADR-0001](0001-draft-recovery-with-mtime-conflict-resolution.md) 的「关闭 tab 时写草稿」路径，而整体退出这条路径根本没走到——用户点右上角关闭，改动静默丢失。未命名标签（`path === null`）更没有任何落盘通道。

讨论中确认了产品改判：**退出时不弹「保存 / 不保存 / 取消」对话框，静默落盘**。理由是本项目已有草稿恢复机制（ADR-0001），再弹一次对话框只会打断「关掉应用」这个明确意图；草稿在下次启动时恢复，用户感知不到丢失。

## 决策

采用「Rust 拦截 → 通知前端落盘 → 前端回调退出」的两段式流程：

1. **Rust 侧拦截**：`Builder::on_window_event` 捕获 `WindowEvent::CloseRequested`，对主窗口（`label == "main"`）调用 `api.prevent_close()` 并 emit `app-close-requested` 事件；设置窗口等其他窗口不拦截（关闭设置窗口不应退出应用）。
2. **状态机保证单次进入**：`ClosingState(AtomicBool)`（[lifecycle.rs](../../src-tauri/src/commands/lifecycle.rs)）用 `swap` 保证「拦截 → 落盘 → 退出」只进入一次。重复的关闭请求（用户在落盘期间连点关闭）保持拦截并忽略——此时放行会让未落盘的改动丢失，而前端有超时兜底，最终一定会走到 `exit_app`。
3. **前端落盘**（[useExitFlush.ts](../../src/composables/useExitFlush.ts)）：
   - 已命名且 `isDirty` 的 tab → `saveDraft(path, content, lastMtime)`（沿用 ADR-0001 草稿 + mtime 冲突检测）；
   - 全部 tab → 刷新 `tabs.json`（未命名 tab 的 `content` 只能靠这里保留）；
   - 完成后 `invoke("exit_app")`。
4. **兜底不可卡死**：单步异常只记日志不抛出；整段落盘与 3s 超时 `Promise.race`，超时直接退出；`exit_app` 调用失败时 `destroy()` 主窗口作为最后保底。`Ctrl+Q` / 菜单「退出」仍走 `close()`，因此自动进入同一流程。
5. 顺带清理 `useTabsStore.closeAll()` 死代码（零调用，且语义已被 `useExitFlush` 取代）。

## 理由

1. **草稿优先于对话框** —— 项目已有 ADR-0001 的草稿 + mtime 冲突解决机制，退出路径复用它比新增一套「退出前逐个文件确认」的交互更一致，也不会因为用户误点「不保存」造成真实丢失。
2. **拦截必须放在 Rust** —— WebView 内无法阻止窗口关闭（`beforeunload` 在 Tauri 里不可靠且无法异步等待落盘），只有原生侧 `prevent_close()` 才能真正「先落盘再关」。
3. **必须等异步落盘完成** —— 草稿与 `tabs.json` 都是异步 IPC，不能在窗口销毁过程中发起；回调式两段退出是唯一能保证完成的方式。
4. **不弹对话框是产品取舍** —— 用户点关闭时的意图是「结束使用」而非「放弃修改」；静默落盘 + 下次恢复符合这一意图，代价是用户不被告知（可接受，因为有可恢复的兜底）。

## 备选方案

**弹「保存 / 不保存 / 取消」对话框（对齐 tab 关闭逻辑）** —— 被否决：多 tab 场景要收敛成一次汇总确认，交互成本高；且用户明确改判为静默落盘。

**只在前端 `beforeunload` 里同步落盘** —— 被否决：WebView2 中 `beforeunload` 无法可靠阻止关闭，也无法 await 异步 IPC。

**Rust 侧直接同步落盘（不通知前端）** —— 被否决：Rust 不持有编辑器的最新内存内容与 dirty 状态，做不到。

**拦截所有窗口的 CloseRequested** —— 被否决：关闭设置窗口会连带退出应用。

## 后果

**正面**

- 退出时未保存改动（含未命名标签）不再丢失，下次启动可恢复。
- 零交互成本：关闭即落盘，不打断用户。
- 落盘异常有超时与 `destroy()` 双层兜底，不会出现「关不掉的应用」。

**负面**

- 退出路径新增一次 IPC 往返（落盘 + `exit_app`），关闭有极短延迟（通常 <100ms）。
- 落盘时间超过 3s 时会带风险退出（草稿可能不完整），极端场景才会触发。
- 退出流程的默认行为改变后，未来若要恢复「退出前确认」需重新评估此 ADR。

## 实施边界

### 文件改动

- 新建 `src-tauri/src/commands/lifecycle.rs`（`ClosingState` + `intercept_close_request` + `exit_app`），`src/composables/useExitFlush.ts`(+test)。
- 改 `src-tauri/src/lib.rs`（`manage(ClosingState)` + `on_window_event` + 注册命令）、`src-tauri/src/commands/mod.rs`、`src/App.vue`（注册 `app-close-requested` 监听并在卸载时清理）、`src/stores/useTabsStore.ts`（删除 `closeAll` 死代码）。

### 测试

- `useExitFlush.test.ts`：dirty/未命名/`lastMtime` 为 null/单步失败继续/`persist` 失败不抛出。
- Rust：`ClosingState::begin` 只进入一次。
- `npm test` 全绿 + `npm run build` 通过。

### 范围外

- 退出前确认对话框（产品已改判为静默落盘）。
- 崩溃 / 进程被强杀时的落盘（依赖既有草稿自动保存路径）。
