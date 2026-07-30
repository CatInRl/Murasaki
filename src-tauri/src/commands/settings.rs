use tauri::{AppHandle, Emitter, Manager};

/// 在主窗口内通过 hash 路由切换到设置页（单入口路由，见 ADR-0009 变更）
///
/// 原 Tauri 多窗口方案在生产环境因 WebView2 第二窗口加载 settings.html
/// 失败导致白屏，改为在主窗口内通过 `navigate` 事件触发前端路由切换。
pub fn show_settings_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.emit("navigate", "settings").map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 前端可调用的 Tauri 命令：打开设置页（在主窗口内导航）
#[tauri::command]
pub fn open_settings(app: AppHandle) -> Result<(), String> {
    show_settings_window(&app)
}
