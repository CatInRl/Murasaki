use std::sync::Mutex;

/// 启动参数中待打开的文件/文件夹路径（issue #92 / #113）。
///
/// Rust 在 `setup` 阶段把 argv 中的路径暂存于此，前端初始化完成后调用
/// [`take_pending_open_path`] 主动取走。相比"固定延时 emit 事件"的推模型，
/// 拉取模型不受前端挂载与恢复耗时影响，避免事件在前端注册监听器之前发出而丢失
/// （表现为冷启动时只恢复了上次的 tabs，未打开双击的文件）。
pub struct PendingOpenState {
    path: Mutex<Option<String>>,
}

impl Default for PendingOpenState {
    fn default() -> Self {
        Self {
            path: Mutex::new(None),
        }
    }
}

impl PendingOpenState {
    /// 暂存启动参数路径，供前端后续取走
    pub fn set(&self, path: String) {
        if let Ok(mut slot) = self.path.lock() {
            *slot = Some(path);
        }
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

/// 取走首次启动时命令行传入的文件/文件夹路径（取一次即清空，避免重复打开）。
///
/// 返回值与 `open-from-argv` 事件 payload 同构（`{ path, type }`），
/// 前端可复用同一套处理逻辑。
#[tauri::command]
pub fn take_pending_open_path(
    state: tauri::State<'_, PendingOpenState>,
) -> Option<serde_json::Value> {
    let mut slot = state.path.lock().ok()?;
    let path = slot.take()?;
    Some(serde_json::json!({
        "path": path,
        "type": classify_path(std::path::Path::new(&path)),
    }))
}