use std::path::PathBuf;
use std::sync::Mutex;
use std::collections::HashSet;
use tauri::{AppHandle, Emitter, Manager};
use notify::{Watcher, RecursiveMode, EventKind, RecommendedWatcher};

/// 文件监听器状态：保存已激活的 watcher 实例
pub struct WatcherState {
    pub watcher: Mutex<Option<RecommendedWatcher>>,
    pub watched_paths: Mutex<HashSet<String>>,
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
            // 只关心文件修改/创建/删除事件
            let relevant = matches!(
                event.kind,
                EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
            );
            if !relevant {
                return;
            }
            // 对每个受影响的路径，发送事件到前端
            for p in &event.paths {
                let path_str = p.to_string_lossy().to_string();
                let _ = app_handle.emit("file-changed", path_str);
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
// 这里仅测试 state 默认值与基本锁机制。
#[cfg(test)]
mod tests {
    use super::*;

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
}
