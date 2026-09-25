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
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// 退出流程状态：各窗口的 `CloseRequested → 落盘 → close_window` 只允许进入一次
#[derive(Default)]
pub struct ClosingState(Mutex<HashSet<String>>);

impl ClosingState {
    /// 尝试为某窗口进入落盘流程；该窗口已在流程中返回 false
    pub fn begin(&self, label: &str) -> bool {
        let mut set = self.0.lock().unwrap_or_else(|e| e.into_inner());
        set.insert(label.to_string())
    }
}

/// 处理窗口关闭请求。
/// 返回 true 表示已拦截（调用方需 `prevent_close`），false 表示放行。
///
/// 重复请求（用户在落盘期间再点关闭）保持拦截并忽略 —— 前端有落盘超时兜底，
/// 一定会走到 `close_window`；若此时放行会让未落盘的改动直接丢失。
///
/// 注意用 `emit_to` 而非 `emit`：Tauri 的 `emit` 是**广播**（发给所有 webview），
/// 多窗口下会把「关闭我」通知给全部窗口，导致所有窗口一起关掉。
pub fn intercept_close_request(window: &tauri::Window) -> bool {
    let state = window.app_handle().state::<ClosingState>();
    if !state.begin(window.label()) {
        return true;
    }
    let _ = window.emit_to(window.label(), "app-close-requested", ());
    true
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
    let windows = app.webview_windows();
    if windows.is_empty() {
        app.exit(0);
        return;
    }
    for (label, window) in windows {
        app.state::<ClosingState>().begin(&label);
        // 逐窗口定向发送：用广播会让每个窗口收到 N 次（N = 窗口数）
        let _ = window.emit_to(label.as_str(), "app-close-requested", ());
    }
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
}
