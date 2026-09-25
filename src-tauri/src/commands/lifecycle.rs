//! 应用退出流程（issue #185 / ADR-0017）
//!
//! 关闭主窗口时不直接退出：先拦截 `CloseRequested`，通过 `app-close-requested`
//! 事件通知前端把未保存改动静默落盘（草稿 + tabs.json），前端完成后调用
//! [`exit_app`] 真正退出。设置窗口等其他窗口的关闭不受影响。

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

/// 退出流程状态：`CloseRequested → 落盘 → exit_app` 只允许进入一次
#[derive(Default)]
pub struct ClosingState(AtomicBool);

impl ClosingState {
    /// 尝试进入退出流程；已在流程中返回 false
    pub fn begin(&self) -> bool {
        !self.0.swap(true, Ordering::SeqCst)
    }
}

/// 处理主窗口关闭请求。
/// 返回 true 表示已拦截（调用方需 `prevent_close`），false 表示放行。
///
/// 重复请求（用户在落盘期间再点关闭）保持拦截并忽略 —— 前端有落盘超时兜底，
/// 一定会走到 `exit_app`；若此时放行会让未落盘的改动直接丢失。
pub fn intercept_close_request(window: &tauri::Window) -> bool {
    if window.label() != "main" {
        return false;
    }
    let state = window.app_handle().state::<ClosingState>();
    if !state.begin() {
        return true;
    }
    let _ = window.emit("app-close-requested", ());
    true
}

/// 前端落盘完成后调用，真正退出应用（菜单退出 / Ctrl+Q / 关闭主窗口共用）
#[tauri::command]
pub fn exit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::ClosingState;

    #[test]
    fn begin_only_once() {
        let state = ClosingState::default();
        assert!(state.begin());
        assert!(!state.begin());
        assert!(!state.begin());
    }
}
