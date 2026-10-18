//! 应用退出流程（issue #185 / ADR-0017；多窗口改造见 spec #194 / T1.4）
//!
//! 关闭窗口时不直接退出：先拦截 `CloseRequested`，通过 `app-close-requested`
//! 事件通知前端把未保存改动静默落盘（草稿 + tabs.json），前端完成后调用
//! [`super::windows::close_window`] 真正销毁该窗口。
//!
//! 多窗口语义：每个编辑器窗口**各自**拦截、各自落盘；关闭最后一个窗口时
//! 由 `close_window` / [`super::windows::exit_if_no_windows`] 退出应用。
//! 不再存在「主窗口」特殊语义（旧实现只认 `label == "main"`）。

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use super::windows::is_editor_window;

/// 退出流程超时兜底：所有窗口都卡在落盘时，多久后强制退出。
///
/// 取得较长是为了不干扰「未保存改动」确认框 —— 用户可能花一两分钟决定；
/// 真正的卡死（前端失联）最终仍会被兜底收掉。
const EXIT_TIMEOUT: Duration = Duration::from_secs(120);

/// 退出流程状态：各窗口的 `CloseRequested → 落盘 → close_window` 只允许进入一次
#[derive(Default)]
pub struct ClosingState {
    closing: Mutex<HashSet<String>>,
    /// 看门狗代际：每次布防自增，旧线程醒来发现代际不符就直接退出
    generation: AtomicU64,
}

impl ClosingState {
    /// 尝试为某窗口进入落盘流程；该窗口已在流程中返回 false
    pub fn begin(&self, label: &str) -> bool {
        let mut set = self.closing.lock().unwrap_or_else(|e| e.into_inner());
        set.insert(label.to_string())
    }

    /// 开始一轮新的看门狗（旧线程会因代际不符而失效）
    fn next_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn is_current_generation(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    /// 让某窗口退出落盘流程（issue #377）：用户在退出确认里选「取消」后由
    /// 前端经 [`cancel_close`] 调用。不退出的话残留的 label 会让后续
    /// CloseRequested 在 [`intercept_close_request`] 里被吞掉，关闭按钮永久失效。
    pub fn cancel(&self, label: &str) {
        let mut set = self.closing.lock().unwrap_or_else(|e| e.into_inner());
        set.remove(label);
    }

    /// 这些窗口是否**全部**仍在落盘流程中。
    ///
    /// 超时兜底只在「一个都没退出、也没人取消」时触发；只要有一个窗口
    /// 调过 `cancel_close`，就不能替用户做决定。
    pub fn all_closing(&self, labels: &[String]) -> bool {
        if labels.is_empty() {
            return false;
        }
        let set = self.closing.lock().unwrap_or_else(|e| e.into_inner());
        labels.iter().all(|label| set.contains(label))
    }
}

/// 处理窗口关闭请求。
/// 返回 true 表示已拦截（调用方需 `prevent_close`），false 表示放行。
///
/// 重复请求（用户在落盘期间再点关闭）保持拦截并忽略 —— 前端有落盘超时兜底，
/// 一定会走到 `close_window`；若此时放行会让未落盘的改动直接丢失。
///
/// 注意用 `emit_to` 而非 `emit`，并且前端必须用 `getCurrentWebviewWindow().listen`
/// 注册监听器 —— 两边的 target 都必须是窗口级：裸 `emit` 会发给所有 webview，
/// 而裸 `listen` 的 `Any` target 会匹配一切 emit（含定向 emit_to），
/// 任一环节退化都会让「关闭我」的通知落到全部窗口，导致所有窗口一起关掉。
pub fn intercept_close_request(window: &tauri::Window) -> bool {
    // PDF 导出的隐藏窗口没有前端：放行关闭（调用方改用 destroy 时不会走到这里）
    if !is_editor_window(window.label()) {
        return false;
    }
    let state = window.app_handle().state::<ClosingState>();
    if !state.begin(window.label()) {
        return true;
    }
    let _ = window.emit_to(window.label(), "app-close-requested", ());
    // 关闭最后一个窗口同样是「退出应用」，一样需要超时兜底
    arm_exit_watchdog(window.app_handle().clone(), state.next_generation());
    true
}

/// 用户在退出确认里选「取消」后调用：退出本窗口的关闭拦截流程（issue #377）。
/// 见 [`ClosingState::cancel`]。
#[tauri::command]
pub fn cancel_close(window: tauri::Window) {
    let state = window.app_handle().state::<ClosingState>();
    state.cancel(window.label());
}

/// 前端落盘完成后调用，真正退出应用（兼容旧调用点 / 兜底路径）
#[tauri::command]
pub fn exit_app(app: AppHandle) {
    app.exit(0);
}

/// 退出整个应用（菜单「退出」/ `Ctrl+Q`）。
///
/// 逐个通知所有窗口落盘，各窗口落盘完成后各自 `close_window`，
/// 最后一个窗口负责 `app.exit(0)` —— 保证其它窗口的未保存内容不会因
/// 「只关当前窗口」而丢失。
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    // 只通知编辑器窗口：PDF 导出的隐藏 webview 没有前端监听，永远等不到它落盘
    let windows: Vec<(String, tauri::WebviewWindow)> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| is_editor_window(label))
        .collect();
    if windows.is_empty() {
        app.exit(0);
        return;
    }

    let generation = app.state::<ClosingState>().next_generation();
    for (label, window) in windows {
        app.state::<ClosingState>().begin(&label);
        // 逐窗口定向发送：用广播会让每个窗口收到 N 次（N = 窗口数）
        let _ = window.emit_to(label.as_str(), "app-close-requested", ());
    }

    arm_exit_watchdog(app, generation);
}

/// 退出超时兜底：前端落盘卡住时强制退出，避免应用永久停在「正在退出」。
///
/// 只在这些窗口**全部**仍处于关闭流程时触发；用户取消退出后 `cancel_close`
/// 会移除对应 label，兜底不会抢在用户前面退出。
fn arm_exit_watchdog(app: AppHandle, generation: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(EXIT_TIMEOUT);

        let state = app.state::<ClosingState>();
        // 期间又发生过新的关闭 / 退出请求：以新看门狗为准
        if !state.is_current_generation(generation) {
            return;
        }
        let remaining: Vec<String> = app
            .webview_windows()
            .keys()
            .filter(|label| is_editor_window(label))
            .cloned()
            .collect();
        if remaining.is_empty() {
            return;
        }
        if !state.all_closing(&remaining) {
            return;
        }
        app.exit(0);
    });
}

#[cfg(test)]
mod tests {
    use super::ClosingState;

    #[test]
    fn begin_only_once_per_window() {
        let state = ClosingState::default();
        assert!(state.begin("win-1"));
        assert!(!state.begin("win-1"));
        assert!(!state.begin("win-1"));
    }

    #[test]
    fn begin_is_scoped_per_window() {
        let state = ClosingState::default();
        assert!(state.begin("main"));
        // 其它窗口不受影响，仍可进入自己的落盘流程
        assert!(state.begin("win-1"));
    }

    // issue #377：用户在退出确认里选「取消」后，前端调 cancel_close 退出落盘流程，
    // 再次点关闭必须能重新进入 —— 否则该窗口的关闭按钮永久失效
    #[test]
    fn cancel_allows_reentry_after_user_cancels() {
        let state = ClosingState::default();
        assert!(state.begin("win-1"));
        state.cancel("win-1");
        assert!(state.begin("win-1"));
    }

    #[test]
    fn cancel_unknown_label_is_noop() {
        let state = ClosingState::default();
        state.cancel("win-1");
        assert!(state.begin("win-1"));
    }

    #[test]
    fn all_closing_requires_every_window() {
        let state = ClosingState::default();
        state.begin("main");
        assert!(!state.all_closing(&["main".to_string(), "win-1".to_string()]));
        state.begin("win-1");
        assert!(state.all_closing(&["main".to_string(), "win-1".to_string()]));
    }

    #[test]
    fn all_closing_false_after_cancel() {
        let state = ClosingState::default();
        state.begin("main");
        state.begin("win-1");
        state.cancel("win-1");
        assert!(!state.all_closing(&["main".to_string(), "win-1".to_string()]));
    }

    #[test]
    fn all_closing_false_for_empty_list() {
        let state = ClosingState::default();
        assert!(!state.all_closing(&[]));
    }

    #[test]
    fn cancel_is_scoped_per_window() {
        let state = ClosingState::default();
        assert!(state.begin("main"));
        assert!(state.begin("win-1"));
        state.cancel("main");
        // 未取消的窗口仍在流程中，重复关闭依旧被拦截（防丢数据，ADR-0017）
        assert!(!state.begin("win-1"));
        assert!(state.begin("main"));
    }
}
