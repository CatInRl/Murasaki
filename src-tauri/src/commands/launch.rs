use std::collections::HashMap;
use std::sync::Mutex;

/// 待打开的文件/文件夹路径（issue #92 / #113，多窗口改造见 spec #194 / T1.3）。
///
/// Rust 在 `setup` 或新建窗口时把路径暂存于此，前端初始化完成后调用
/// [`take_pending_open_path`] 主动取走。相比"固定延时 emit 事件"的推模型，
/// 拉取模型不受前端挂载与恢复耗时影响，避免事件在前端注册监听器之前发出而丢失
/// （表现为冷启动时只恢复了上次的 tabs，未打开双击的文件）。
///
/// 多窗口后**按窗口 label 分槽**：每个窗口只能取走自己的路径，避免互相抢。
pub struct PendingOpenState {
    paths: Mutex<HashMap<String, String>>,
}

impl Default for PendingOpenState {
    fn default() -> Self {
        Self {
            paths: Mutex::new(HashMap::new()),
        }
    }
}

impl PendingOpenState {
    /// 暂存某窗口的待打开路径，供该窗口前端后续取走
    pub fn set_for(&self, label: &str, path: String) {
        if let Ok(mut slots) = self.paths.lock() {
            slots.insert(label.to_string(), path);
        }
    }

    /// 取走某窗口的待打开路径（取一次即清空）
    pub fn take(&self, label: &str) -> Option<String> {
        self.paths.lock().ok()?.remove(label)
    }
}

/// 判断路径是文件还是目录（用于拖拽打开 / 命令行参数打开文件关联，issue #92 / #113）
pub fn classify_path(p: &std::path::Path) -> &'static str {
    if p.is_dir() {
        "folder"
    } else {
        "file"
    }
}

/// 返回首个非 `--flag` 的命令行参数（文件/文件夹路径）。
/// 用于首次启动时文件关联（双击 .md 文件）与命令行拖入打开。
pub fn first_non_flag_arg() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with("--") && !a.is_empty())
}

/// 取走**本窗口**的待打开文件/文件夹路径（取一次即清空，避免重复打开）。
///
/// 返回值与 `open-from-argv` 事件 payload 同构（`{ path, type }`），
/// 前端可复用同一套处理逻辑。
///
/// 前端在启动早期即调用本命令：拿到路径意味着「本窗口是被外部入口创建的」
/// （冷启动带参数 / 运行中双击文件 / 打开文件夹），此时**不恢复**上次工作区与标签
/// （决策 ④）——新窗口与带参数启动都应当是干净会话。
#[tauri::command]
pub fn take_pending_open_path(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, PendingOpenState>,
) -> Option<serde_json::Value> {
    let path = state.take(window.label())?;
    Some(serde_json::json!({
        "path": path,
        "type": classify_path(std::path::Path::new(&path)),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn take_is_scoped_per_window() {
        let state = PendingOpenState::default();
        state.set_for("main", "/tmp/a.md".to_string());
        state.set_for("win-1", "/tmp/b.md".to_string());
        assert_eq!(state.take("win-1").as_deref(), Some("/tmp/b.md"));
        // win-1 已取走，main 不受影响
        assert_eq!(state.take("win-1"), None);
        assert_eq!(state.take("main").as_deref(), Some("/tmp/a.md"));
    }

    #[test]
    fn take_missing_window_returns_none() {
        let state = PendingOpenState::default();
        assert_eq!(state.take("win-9"), None);
    }
}
