//! 多窗口基础设施（spec #194 / T1.1）
//!
//! 多工作区 = 多窗口：每个窗口一个独立 WebView，前端 Pinia 状态天然按窗口隔离。
//! 本模块负责 Rust 侧跨窗口共享的部分：
//! - **窗口 → 工作区注册表**：用于「同一文件夹已在某窗口打开则聚焦」与窗口销毁清理
//! - **建窗 / 关窗命令**：`open_path_in_new_window`、`close_window`
//!
//! 窗口路径的传递沿用「拉取模型」（issue #113）：新建窗口时把路径写入
//! [`PendingOpenState`] 的对应 label 槽，前端初始化完成后主动取走。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use super::launch::{classify_path, PendingOpenState};

/// 窗口 ↔ 工作区注册表。
///
/// - `workspaces`：window label → 该窗口当前工作区根路径
/// - `counter`：新窗口 label 序号（`win-1` / `win-2` …）
/// - `exiting`：退出流程防重入（多个窗口的 `Destroyed` 事件可能同时判定「已无窗口」）
#[derive(Default)]
pub struct WindowRegistry {
    workspaces: Mutex<HashMap<String, String>>,
    counter: Mutex<u64>,
    exiting: AtomicBool,
}

/// 路径归一化，用于「是否同一目录」的比较。
///
/// Windows 路径大小写不敏感且分隔符混用（`\` 与 `/`），统一为小写 + `/`，
/// 并去掉尾部斜杠，避免同一个目录因写法不同而被判为两个工作区。
fn normalize_path(path: &str) -> String {
    let unified = path.replace('\\', "/");
    let trimmed = unified.trim_end_matches('/');
    let result = if trimmed.is_empty() { unified.as_str() } else { trimmed };
    if cfg!(windows) {
        result.to_lowercase()
    } else {
        result.to_string()
    }
}

impl WindowRegistry {
    /// 分配一个新的窗口 label
    pub fn next_label(&self) -> String {
        let mut counter = self.counter.lock().unwrap_or_else(|e| e.into_inner());
        *counter += 1;
        format!("win-{}", *counter)
    }

    /// 登记（或清除）某窗口的工作区
    pub fn set_workspace(&self, label: &str, path: Option<String>) {
        let mut map = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
        match path {
            Some(p) => {
                map.insert(label.to_string(), p);
            }
            None => {
                map.remove(label);
            }
        }
    }

    /// 查询某窗口当前登记的工作区
    pub fn workspace_of(&self, label: &str) -> Option<String> {
        let map = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
        map.get(label).cloned()
    }

    /// 反查：哪个窗口已打开该工作区（用于同目录聚焦）
    pub fn window_for_workspace(&self, path: &str) -> Option<String> {
        let target = normalize_path(path);
        let map = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
        map.iter()
            .find(|(_, p)| normalize_path(p) == target)
            .map(|(label, _)| label.clone())
    }

    /// 清除某窗口的全部登记（窗口销毁时调用）
    pub fn remove(&self, label: &str) {
        let mut map = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(label);
    }

    /// 尝试进入退出流程；已在流程中返回 false
    pub fn begin_exit(&self) -> bool {
        !self.exiting.swap(true, Ordering::SeqCst)
    }
}

/// 创建编辑器窗口。`path` 为 `None` 时创建空白窗口。
///
/// - `path` 是**目录**：先查注册表，命中则聚焦已有窗口并返回其 label（不建新窗）；
///   未命中才建窗，并**预留**注册表位（前端尚未上报前即可去重）。
/// - `path` 是**文件**：建窗，路径写入该窗口的 [`PendingOpenState`] 槽。
///
/// 无论文件还是目录，路径都会写入 pending 槽，由前端拉取后统一走 `onOpenPath`
/// 处理（文件 → 开 tab；目录 → 设工作区），单一机制便于维护。
pub fn create_editor_window(app: &AppHandle, path: Option<String>) -> Result<String, String> {
    let registry = app.state::<WindowRegistry>();

    // 目录且已有窗口打开 → 聚焦，不重复开窗（避免同目录双 watcher 与文件操作冲突）
    if let Some(p) = path.as_deref() {
        if std::path::Path::new(p).is_dir() {
            if let Some(existing) = registry.window_for_workspace(p) {
                if let Some(window) = app.get_webview_window(&existing) {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                    return Ok(existing);
                }
                // 窗口已不存在（异常残留）→ 清掉后走正常建窗流程
                registry.remove(&existing);
            }
        }
    }

    let label = registry.next_label();
    WebviewWindowBuilder::new(app, &label, WebviewUrl::default())
        .title("Murasaki")
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .resizable(true)
        .fullscreen(false)
        .build()
        .map_err(|e| format!("创建窗口失败: {}", e))?;

    if let Some(p) = path {
        // 目录预留注册表位，让后续同目录请求能命中（前端上报后会覆盖）
        if std::path::Path::new(&p).is_dir() {
            registry.set_workspace(&label, Some(p.clone()));
        }
        app.state::<PendingOpenState>().set_for(&label, p);
    }

    Ok(label)
}

/// 清理某窗口在各全局状态里的残留（窗口销毁时调用）。
pub fn cleanup_window_state(app: &AppHandle, label: &str) {
    app.state::<WindowRegistry>().remove(label);
    app.state::<super::watcher::WatcherState>().remove_window(label);
    app.state::<super::menu::RecentMenuState>().remove_window_ui(label);
}

/// 前端调用：在**新窗口**中打开路径（「打开文件夹」入口）。
///
/// 目录：命中已有窗口则聚焦并返回其 label；文件：新窗口打开该文件。
pub fn open_path_in_new_window_impl(app: &AppHandle, path: &str) -> Result<String, String> {
    if !std::path::Path::new(path).exists() {
        return Err(format!("路径不存在: {}", path));
    }
    create_editor_window(app, Some(path.to_string()))
}

/// 前端调用：在新窗口中打开文件/文件夹路径
#[tauri::command]
pub fn open_path_in_new_window(app: AppHandle, path: String) -> Result<String, String> {
    open_path_in_new_window_impl(&app, &path)
}

/// 前端调用：上报/清除本窗口的工作区（`null` = 已关闭工作区）
#[tauri::command]
pub fn set_window_workspace(window: WebviewWindow, app: AppHandle, path: Option<String>) {
    app.state::<WindowRegistry>()
        .set_workspace(window.label(), path);
}

/// 前端调用：关闭本窗口。
///
/// 关闭后若已无其它编辑器窗口，则退出应用 —— 实现「关最后一个窗口才退出」
/// （Windows / macOS 行为一致，不依赖「主窗口」特殊语义）。
#[tauri::command]
pub fn close_window(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    let label = window.label().to_string();
    cleanup_window_state(&app, &label);
    window.destroy().map_err(|e| e.to_string())?;
    // 数剩余窗口时排除自己：destroy 之后 `webview_windows()` 的回收时机不确定
    exit_if_no_other_windows(&app, &label);
    Ok(())
}

/// 除 `closed_label` 外已无窗口时退出应用。
///
/// 两个调用点：`close_window`（正常路径）与窗口 `Destroyed` 事件（兜底 ——
/// 前端落盘失败时会直接 `destroy()` 绕过 `close_window`）。
/// `WindowRegistry::begin_exit` 保证只退出一次。
pub fn exit_if_no_other_windows(app: &AppHandle, closed_label: &str) {
    let remaining = app
        .webview_windows()
        .keys()
        .filter(|l| l.as_str() != closed_label)
        .count();
    if remaining > 0 {
        return;
    }
    if app.state::<WindowRegistry>().begin_exit() {
        app.exit(0);
    }
}

/// 路径分类的再导出，便于前端调用方与 `launch` 保持一致
pub fn classify(path: &str) -> &'static str {
    classify_path(std::path::Path::new(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_label_increments() {
        let registry = WindowRegistry::default();
        assert_eq!(registry.next_label(), "win-1");
        assert_eq!(registry.next_label(), "win-2");
        assert_eq!(registry.next_label(), "win-3");
    }

    #[test]
    fn set_and_get_workspace() {
        let registry = WindowRegistry::default();
        registry.set_workspace("win-1", Some("/tmp/a".to_string()));
        assert_eq!(registry.workspace_of("win-1").as_deref(), Some("/tmp/a"));
        registry.set_workspace("win-1", None);
        assert_eq!(registry.workspace_of("win-1"), None);
    }

    #[test]
    fn window_for_workspace_matches_normalized_path() {
        let registry = WindowRegistry::default();
        registry.set_workspace("win-1", Some("/tmp/a/".to_string()));
        // 尾部分隔符差异不应影响命中
        assert_eq!(
            registry.window_for_workspace("/tmp/a").as_deref(),
            Some("win-1")
        );
    }

    #[test]
    fn window_for_workspace_misses_other_path() {
        let registry = WindowRegistry::default();
        registry.set_workspace("win-1", Some("/tmp/a".to_string()));
        assert_eq!(registry.window_for_workspace("/tmp/b"), None);
    }

    #[test]
    fn remove_clears_registration() {
        let registry = WindowRegistry::default();
        registry.set_workspace("win-1", Some("/tmp/a".to_string()));
        registry.remove("win-1");
        assert_eq!(registry.workspace_of("win-1"), None);
        assert_eq!(registry.window_for_workspace("/tmp/a"), None);
    }

    #[test]
    fn begin_exit_only_once() {
        let registry = WindowRegistry::default();
        assert!(registry.begin_exit());
        assert!(!registry.begin_exit());
    }

    #[test]
    fn normalize_path_unifies_separators_and_trailing_slash() {
        let a = normalize_path("/tmp/a/");
        let b = normalize_path("/tmp/a");
        assert_eq!(a, b);
        assert_eq!(normalize_path("/tmp/a\\b"), normalize_path("/tmp/a/b"));
    }
}