use std::path::PathBuf;
use std::sync::Mutex;
use std::collections::HashSet;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use notify::event::ModifyKind;
use notify::{Watcher, RecursiveMode, EventKind, RecommendedWatcher};

/// 文件监听器状态：保存已激活的 watcher 实例
pub struct WatcherState {
    pub watcher: Mutex<Option<RecommendedWatcher>>,
    pub watched_paths: Mutex<HashSet<String>>,
}

/// `file-changed` 事件负载。
/// `kind` 用于区分「内容修改」与「结构变化（新建/删除/重命名）」：
/// 前端只对结构变化刷新文件树，避免编辑器每次保存都触发全量重扫。
#[derive(Clone, Serialize)]
pub struct FileChangedPayload {
    pub path: String,
    pub kind: &'static str,
}

/// 把 notify 事件类别归类为前端可用的 kind。
/// 返回 None 表示不关心的事件（访问、只读打开等）。
fn classify_event(kind: &EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Create(_) => Some("create"),
        EventKind::Remove(_) => Some("remove"),
        // 重命名在 notify 中属于 Modify(Name(..))，对文件树而言是结构变化，
        // 必须单独归类，否则外部重命名会被当成内容修改而漏刷新。
        EventKind::Modify(ModifyKind::Name(_)) => Some("rename"),
        EventKind::Modify(_) => Some("modify"),
        _ => None,
    }
}

impl Default for WatcherState {
    fn default() -> Self {
        Self {
            watcher: Mutex::new(None),
            watched_paths: Mutex::new(HashSet::new()),
        }
    }
}

/// 启动工作区文件监听
/// 当文件被外部修改时，通过 Tauri 事件 `file-changed` 通知前端
/// 事件 payload 为变更文件的绝对路径
#[tauri::command]
pub fn start_watching(
    app: AppHandle,
    path: String,
) -> Result<(), String> {
    let watch_path = PathBuf::from(&path);
    if !watch_path.exists() {
        return Err(format!("路径不存在: {}", path));
    }

    let state = app.state::<WatcherState>();
    let mut watched = state.watched_paths.lock().map_err(|e| e.to_string())?;
    // 已在监听该路径：直接返回成功
    if watched.contains(&path) {
        return Ok(());
    }

    let app_handle = app.clone();
    let mut watcher = match notify::recommended_watcher(move |res: Result<notify::Event, _>| {
        if let Ok(event) = res {
            // 只关心内容修改 / 新建 / 删除 / 重命名
            let Some(kind) = classify_event(&event.kind) else {
                return;
            };
            // 对每个受影响的路径，发送事件到前端
            for p in &event.paths {
                let _ = app_handle.emit(
                    "file-changed",
                    FileChangedPayload {
                        path: p.to_string_lossy().to_string(),
                        kind,
                    },
                );
            }
        }
    }) {
        Ok(w) => w,
        Err(e) => return Err(format!("创建监听器失败: {}", e)),
    };

    // 添加监听路径（递归）
    let mode = if watch_path.is_dir() {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    };
    if let Err(e) = watcher.watch(&watch_path, mode) {
        return Err(format!("添加监听路径失败: {}", e));
    }

    // 保存 watcher
    let mut guard = state.watcher.lock().map_err(|e| e.to_string())?;
    *guard = Some(watcher);
    watched.insert(path);

    Ok(())
}

/// 停止监听指定路径
#[tauri::command]
pub fn stop_watching(app: AppHandle, path: String) -> Result<(), String> {
    let state = app.state::<WatcherState>();
    let mut watched = state.watched_paths.lock().map_err(|e| e.to_string())?;
    watched.remove(&path);

    // 若没有监听路径了，销毁 watcher
    if watched.is_empty() {
        let mut guard = state.watcher.lock().map_err(|e| e.to_string())?;
        *guard = None;
    }

    Ok(())
}

/// 停止所有监听
#[tauri::command]
pub fn stop_all_watching(app: AppHandle) -> Result<(), String> {
    let state = app.state::<WatcherState>();
    let mut watched = state.watched_paths.lock().map_err(|e| e.to_string())?;
    watched.clear();
    let mut guard = state.watcher.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}

// ===== 单元测试 =====
// 注意：notify 的 watcher 涉及真实文件系统监听，难以在单元测试中验证事件推送。
// 这里测试 state 默认值、锁机制，以及事件类别归类（纯函数，决定前端是否刷文件树）。
#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, DataChange, RemoveKind, RenameMode};

    #[test]
    fn test_watcher_state_default() {
        let state = WatcherState::default();
        assert!(state.watcher.lock().unwrap().is_none());
        assert!(state.watched_paths.lock().unwrap().is_empty());
    }

    #[test]
    fn test_watcher_state_mutex_works() {
        let state = WatcherState::default();
        {
            let mut watched = state.watched_paths.lock().unwrap();
            watched.insert("/tmp/test".to_string());
        }
        let watched = state.watched_paths.lock().unwrap();
        assert!(watched.contains("/tmp/test"));
    }

    #[test]
    fn test_classify_structural_events() {
        assert_eq!(
            classify_event(&EventKind::Create(CreateKind::File)),
            Some("create")
        );
        assert_eq!(
            classify_event(&EventKind::Remove(RemoveKind::File)),
            Some("remove")
        );
        // 重命名是结构变化，不能被归类为 modify
        assert_eq!(
            classify_event(&EventKind::Modify(ModifyKind::Name(RenameMode::Both))),
            Some("rename")
        );
    }

    #[test]
    fn test_classify_content_modify() {
        assert_eq!(
            classify_event(&EventKind::Modify(ModifyKind::Data(DataChange::Content))),
            Some("modify")
        );
        assert_eq!(
            classify_event(&EventKind::Modify(ModifyKind::Any)),
            Some("modify")
        );
    }

    #[test]
    fn test_classify_ignored_events() {
        assert_eq!(classify_event(&EventKind::Access(notify::event::AccessKind::Read)), None);
        assert_eq!(classify_event(&EventKind::Other), None);
    }
}
