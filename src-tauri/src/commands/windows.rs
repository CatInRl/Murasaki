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
use crate::errors::{CommandError, ErrorCode};

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
    let result = if trimmed.is_empty() {
        unified.as_str()
    } else {
        trimmed
    };
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

/// 从工作区路径提取展示名（末段目录名），供窗口标题使用。
///
/// 统一 `\` 与 `/` 两种分隔符并去掉尾部斜杠后取最后一段；
/// 提取结果为空时返回原路径。
fn workspace_display_name(path: &str) -> String {
    let unified = path.replace('\\', "/");
    let trimmed = unified.trim_end_matches('/');
    let name = trimmed.rsplit('/').next().unwrap_or("");
    if name.is_empty() {
        path.to_string()
    } else {
        name.to_string()
    }
}

/// 窗口标题：有工作区时显示「<目录名> — Murasaki」，无则回退「Murasaki」（issue #380）。
pub fn window_title_for_workspace(path: Option<&str>) -> String {
    match path {
        None => "Murasaki".to_string(),
        Some(p) => {
            let name = workspace_display_name(p);
            if name.is_empty() {
                "Murasaki".to_string()
            } else {
                format!("{} — Murasaki", name)
            }
        }
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
pub fn create_editor_window(app: &AppHandle, path: Option<String>) -> Result<String, CommandError> {
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
    // 目录工作区直接以目录名作为初始标题；文件 / 空白窗口保持「Murasaki」。
    // 后续前端上报 set_window_workspace 时还会同步一次。
    let initial_title = match path.as_deref() {
        Some(p) if std::path::Path::new(p).is_dir() => window_title_for_workspace(Some(p)),
        _ => window_title_for_workspace(None),
    };
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::default())
        .title(&initial_title)
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .resizable(true)
        .fullscreen(false);

    // E2E（所有平台）：注入与主窗口相同的 console 捕获脚本（#371）。
    // 新窗口若 __pinia__ 迟迟未暴露，helper 超时时可 dump 出启动期日志。
    if crate::is_e2e_mode() {
        builder = builder.initialization_script(crate::E2E_CONSOLE_HOOK_SCRIPT);
    }

    // E2E：主窗口在 `lib.rs` setup 里按 `--remote-debugging-port` 注入 WebView2 参数，
    // 动态创建的窗口必须注入完全相同的参数 —— 否则 WebView2 因环境选项不同另起一个
    // 浏览器进程，调试端点（msedgedriver / CDP）上看不到新窗口，多窗口 E2E 无从驱动。
    if let Some((extra_args, _port)) = crate::detect_remote_debugging_args() {
        builder = builder.additional_browser_args(&extra_args);
    }

    let window = builder
        .build()
        .map_err(|e| CommandError::internal(format!("create window: {e}")))?;

    // 显式置前（issue #414）。
    //
    // 外部入口（双击 .md / 命令行 / 拖到任务栏）在应用**已运行**时走 single-instance
    // 回调：插件在第二实例退出前调了 `AllowSetForegroundWindow`，把「设置前台窗口」的
    // 权限交给回调，期望**回调自己 focus**。但建窗时 tao 对 `focused: true` 只做
    // `ShowWindow(SW_SHOW)`（`force_window_active` 仅用于 fullscreen 建窗分支），应用
    // 不在前台时这次激活会被 Windows 前台锁拒掉 —— 新窗口只闪一下任务栏、拿不到前台
    // 与键盘焦点。上面「目录已在别处打开 → 聚焦」的分支有同样的 `set_focus()`，这条
    // 建窗路径漏了。
    //
    // `set_focus()` 走 tao → `force_window_active`：先试 `SetForegroundWindow`
    // （此时插件已交权限，通常直接成功），被拒时再以合成 ALT 键抢前台权限。
    let _ = window.set_focus();

    if let Some(p) = path {
        // 目录预留注册表位，让后续同目录请求能命中（前端上报后会覆盖）
        if std::path::Path::new(&p).is_dir() {
            registry.set_workspace(&label, Some(p.clone()));
        }
        app.state::<PendingOpenState>().set_for(&label, p);
    }

    Ok(label)
}

/// PDF 导出隐藏窗口的 label 前缀（创建与识别共用同一来源）
pub const PDF_EXPORT_LABEL_PREFIX: &str = "pdf-export-";

/// 是否为编辑器窗口。
///
/// PDF 导出的隐藏 webview（`pdf-export-*`）没有前端、不参与「关最后一个窗口退出」，
/// 也不应该接收退出事件 —— 否则导出期间关闭最后一个窗口，应用不会退出（#440）。
pub fn is_editor_window(label: &str) -> bool {
    !label.starts_with(PDF_EXPORT_LABEL_PREFIX)
}

/// 清理某窗口在各全局状态里的残留（窗口销毁时调用）。
pub fn cleanup_window_state(app: &AppHandle, label: &str) {
    app.state::<WindowRegistry>().remove(label);
    app.state::<super::watcher::WatcherState>()
        .remove_window(label);
    app.state::<super::menu::RecentMenuState>()
        .remove_window_ui(label);
}

/// 前端调用：在**新窗口**中打开路径（「打开文件夹」入口）。
///
/// 目录：命中已有窗口则聚焦并返回其 label；文件：新窗口打开该文件。
pub fn open_path_in_new_window_impl(app: &AppHandle, path: &str) -> Result<String, CommandError> {
    // 只允许打开已授权路径（对话框刚授权 / 最近列表的持久化授权）
    crate::security::policy().ensure_read(path)?;
    if !std::path::Path::new(path).exists() {
        return Err(CommandError::path(ErrorCode::NotFound, path));
    }
    create_editor_window(app, Some(path.to_string()))
}

/// 前端调用：在新窗口中打开文件/文件夹路径
///
/// 必须是 `async`：同步命令在**主线程**执行，而 `create_editor_window` 内部的
/// `WebviewWindowBuilder::build()` 需要投递窗口创建消息（`send_user_message`）。
/// 主线程上该消息会被内联执行 —— 即在 WebView2 的 IPC 回调里同步创建新的
/// WebView2 环境，实测直接卡死（命令永不返回、窗口也建不出来）。
/// 改成 `async` 后命令在 tokio 工作线程上运行，建窗消息正常投递给主线程事件循环。
#[tauri::command]
pub async fn open_path_in_new_window(app: AppHandle, path: String) -> Result<String, CommandError> {
    open_path_in_new_window_impl(&app, &path)
}

/// 前端调用：上报/清除本窗口的工作区（`null` = 已关闭工作区）
///
/// 只维护注册表，不改窗口标题：标题统一由前端按「工作区名 / 当前文件名」计算
/// 后经 [`set_window_title`] 设置（#442），避免两处写入互相覆盖。
#[tauri::command]
pub fn set_window_workspace(window: WebviewWindow, app: AppHandle, path: Option<String>) {
    app.state::<WindowRegistry>()
        .set_workspace(window.label(), path);
}

/// 前端调用：设置本窗口标题（#442）。
///
/// 无工作区的窗口此前统一叫「Murasaki」，多窗口下任务栏无法区分。
/// 标题由前端统一计算：有工作区用目录名，否则用当前标签名。
#[tauri::command]
pub fn set_window_title(window: WebviewWindow, title: String) {
    let _ = window.set_title(&title);
}

/// 前端调用：关闭本窗口。
///
/// 关闭后若已无其它编辑器窗口，则退出应用 —— 实现「关最后一个窗口才退出」
/// （Windows / macOS 行为一致，不依赖「主窗口」特殊语义）。
#[tauri::command]
pub fn close_window(window: WebviewWindow, app: AppHandle) -> Result<(), CommandError> {
    let label = window.label().to_string();
    cleanup_window_state(&app, &label);
    window
        .destroy()
        .map_err(|e| CommandError::internal(format!("destroy window: {e}")))?;
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
        .filter(|label| label.as_str() != closed_label && is_editor_window(label))
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
    fn pdf_export_windows_are_not_editor_windows() {
        assert!(is_editor_window("main"));
        assert!(is_editor_window("win-1"));
        assert!(is_editor_window("settings"));
        assert!(!is_editor_window("pdf-export-1234"));
    }

    #[test]
    fn normalize_path_unifies_separators_and_trailing_slash() {
        let a = normalize_path("/tmp/a/");
        let b = normalize_path("/tmp/a");
        assert_eq!(a, b);
        assert_eq!(normalize_path("/tmp/a\\b"), normalize_path("/tmp/a/b"));
    }

    #[test]
    fn window_title_without_workspace_is_plain() {
        assert_eq!(window_title_for_workspace(None), "Murasaki");
    }

    #[test]
    fn window_title_uses_workspace_basename() {
        assert_eq!(
            window_title_for_workspace(Some("/home/user/docs")),
            "docs — Murasaki"
        );
    }

    #[test]
    fn window_title_handles_mixed_separators_and_trailing_slash() {
        assert_eq!(
            window_title_for_workspace(Some("C:\\repos\\murasaki\\")),
            "murasaki — Murasaki"
        );
    }

    #[test]
    fn window_title_empty_path_falls_back_to_plain() {
        assert_eq!(window_title_for_workspace(Some("")), "Murasaki");
    }
}
