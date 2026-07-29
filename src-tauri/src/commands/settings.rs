use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// 显示或创建设置窗口（核心逻辑，供 Tauri 命令与菜单事件共用）
///
/// - 已存在（被隐藏）：显示并聚焦
/// - 不存在（被关闭）：重新创建
///
/// 设置窗口采用 Tauri 多窗口形态，详见 ADR-0009。
pub fn show_settings_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    } else {
        WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
            .title("设置")
            .inner_size(800.0, 600.0)
            .min_inner_size(480.0, 400.0)
            .resizable(true)
            .visible(true)
            .build()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 前端可调用的 Tauri 命令：打开设置窗口
#[tauri::command]
pub fn open_settings(app: AppHandle) -> Result<(), String> {
    show_settings_window(&app)
}
