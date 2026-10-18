use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use notify::event::ModifyKind;
use notify::{Watcher, RecursiveMode, EventKind, RecommendedWatcher};
use crate::errors::{CommandError, ErrorCode};

/// 事件合并窗口（毫秒）：把一次爆发期（`git checkout` / `npm install` / 自动保存）
/// 产生的成百上千条事件压成「每个路径一条」。
const DEBOUNCE_MS: u64 = 150;

/// 某窗口的监听器实例与它监听的路径
struct WatcherEntry {
    /// 仅作 RAII 持有：drop 本结构即停止监听，故字段本身不需要读取
    #[allow(dead_code)]
    watcher: RecommendedWatcher,
    path: String,
    /// 通知合并线程退出（drop 时置 true）
    stop: Arc<AtomicBool>,
}

impl Drop for WatcherEntry {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// 待发送的变更：路径 → 事件类型。
///
/// 同一路径在一个窗口内可能连续收到 modify + rename 等事件，
/// 结构变化（create / rename / remove）优先于内容修改。
#[derive(Default)]
struct PendingChanges {
    events: HashMap<String, &'static str>,
}

impl PendingChanges {
    fn push(&mut self, path: String, kind: &'static str) {
        let slot = self.events.entry(path).or_insert(kind);
        if kind_rank(kind) > kind_rank(slot) {
            *slot = kind;
        }
    }

    fn drain(&mut self) -> Vec<(String, &'static str)> {
        self.events.drain().collect()
    }
}

fn kind_rank(kind: &str) -> u8 {
    match kind {
        "modify" => 0,
        "create" => 1,
        "rename" => 2,
        "remove" => 3,
        _ => 0,
    }
}

/// 是否属于文件树同样忽略的噪音（`.git` / `node_modules` 等）。
fn is_ignored(path: &Path) -> bool {
    path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(crate::commands::files::is_noise)
    })
}

/// 文件监听器状态：保存各窗口已激活的 watcher 实例（多窗口改造见 spec #194 / T1.2）。
///
/// 按 **window label** 隔离：每个窗口最多一个监听器（对应其工作区）。
/// 旧实现是单实例 + 路径集合，第二个工作区调用 `start_watching` 会把第一个
/// watcher 顶掉，导致先打开的窗口失去外部变更监听。
#[derive(Default)]
pub struct WatcherState {
    watchers: Mutex<HashMap<String, WatcherEntry>>,
}

impl WatcherState {
    /// 移除并销毁某窗口的监听器（窗口销毁时调用）。
    ///
    /// 注意：**关闭工作区不会走这里** —— 工作区关了但标签还开着，那些文件仍需要外部修改
    /// 提醒，所以前端有意保留 watcher；等下一次打开工作区时，前端会先调本命令再重新注册
    /// （务必先停后启：watcher 盯的是注册那一刻的目录句柄，目录被删/重建后它就哑了，#311）
    pub fn remove_window(&self, label: &str) {
        let mut map = self.watchers.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(label);
    }
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

/// 启动本窗口的工作区文件监听
/// 当文件被外部修改时，通过 Tauri 事件 `file-changed` 通知前端
/// 事件 payload 为变更文件的绝对路径
///
/// 监听器按 window label 存放，**不会影响其它窗口**。同一窗口重复调用同一路径
/// 直接返回（幂等）；换路径时旧监听器随 drop 自动停止。
#[tauri::command]
pub fn start_watching(
    window: WebviewWindow,
    app: AppHandle,
    path: String,
) -> Result<(), CommandError> {
    crate::security::policy().ensure_read(&path)?;
    let watch_path = PathBuf::from(&path);
    if !watch_path.exists() {
        return Err(CommandError::path(ErrorCode::NotFound, &path));
    }

    let state = app.state::<WatcherState>();
    let label = window.label().to_string();
    {
        let map = state
            .watchers
            .lock()
            .map_err(|e| CommandError::internal(format!("watcher lock: {e}")))?;
        if let Some(entry) = map.get(&label) {
            if entry.path == path {
                // 已在监听该路径：直接返回成功
                return Ok(());
            }
        }
    }

    // 合并缓冲：notify 回调只做「分类 + 去重入桶」，真正的 emit 交给下面的合并线程，
    // 避免一次爆发期把成百上千条 IPC 直接打给前端。
    let pending = Arc::new(Mutex::new(PendingChanges::default()));
    let stop = Arc::new(AtomicBool::new(false));
    let callback_pending = Arc::clone(&pending);
    let mut watcher = match notify::recommended_watcher(move |res: Result<notify::Event, _>| {
        let Ok(event) = res else {
            return;
        };
        // 只关心内容修改 / 新建 / 删除 / 重命名
        let Some(kind) = classify_event(&event.kind) else {
            return;
        };
        let mut changes = match callback_pending.lock() {
            Ok(changes) => changes,
            Err(poisoned) => poisoned.into_inner(),
        };
        for p in &event.paths {
            // 与文件树共用同一份噪音清单（.git / node_modules 等）
            if is_ignored(p) {
                continue;
            }
            changes.push(p.to_string_lossy().to_string(), kind);
        }
    }) {
        Ok(w) => w,
        Err(e) => {
            return Err(CommandError::internal(format!("create watcher: {e}"))
                .with_param("path", path.clone()))
        }
    };

    // 添加监听路径（递归）
    let mode = if watch_path.is_dir() {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    };
    if let Err(e) = watcher.watch(&watch_path, mode) {
        return Err(CommandError::internal(format!("watch: {e}")).with_param("path", path.clone()));
    }

    // 合并线程：每 150ms 把桶里的变更按路径各发一条。
    // 事件只发给本窗口：裸 `emit` 是广播，多窗口下所有窗口都会收到
    // 别的窗口工作区的变更通知（前端虽按 workspacePath 过滤，但仍是无谓的
    // 跨窗口噪音，且同目录多窗口时会互相触发重载）。
    let flusher_pending = Arc::clone(&pending);
    let flusher_stop = Arc::clone(&stop);
    let flusher_app = app.clone();
    let flusher_label = label.clone();
    thread::spawn(move || {
        while !flusher_stop.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(DEBOUNCE_MS));
            let batch = match flusher_pending.lock() {
                Ok(mut changes) => changes.drain(),
                Err(poisoned) => poisoned.into_inner().drain(),
            };
            for (changed_path, kind) in batch {
                let _ = flusher_app.emit_to(
                    flusher_label.as_str(),
                    "file-changed",
                    FileChangedPayload {
                        path: changed_path,
                        kind,
                    },
                );
            }
        }
    });

    // 保存本窗口的 watcher（顶掉该窗口的旧实例，不影响其它窗口）
    let mut map = state
        .watchers
        .lock()
        .map_err(|e| CommandError::internal(format!("watcher lock: {e}")))?;
    map.insert(label, WatcherEntry { watcher, path, stop });

    Ok(())
}

/// 停止本窗口的文件监听
#[tauri::command]
pub fn stop_watching(window: WebviewWindow, app: AppHandle) -> Result<(), CommandError> {
    app.state::<WatcherState>().remove_window(window.label());
    Ok(())
}

/// 停止本窗口的全部监听（与 [`stop_watching`] 等价，保留给旧调用方）
#[tauri::command]
pub fn stop_all_watching(window: WebviewWindow, app: AppHandle) -> Result<(), CommandError> {
    app.state::<WatcherState>().remove_window(window.label());
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
    fn test_watcher_state_default_is_empty() {
        let state = WatcherState::default();
        assert!(state.watchers.lock().unwrap().is_empty());
    }

    #[test]
    fn test_remove_window_is_scoped() {
        let state = WatcherState::default();
        // 无法在单测里构造真实 RecommendedWatcher，这里直接验证 map 语义：
        // 两个窗口各占一个槽，删一个不影响另一个
        {
            let mut map = state.watchers.lock().unwrap();
            map.insert(
                "win-1".to_string(),
                WatcherEntry {
                    watcher: notify::recommended_watcher(|_| {}).unwrap(),
                    path: "/tmp/a".to_string(),
                    stop: Arc::new(AtomicBool::new(false)),
                },
            );
            map.insert(
                "win-2".to_string(),
                WatcherEntry {
                    watcher: notify::recommended_watcher(|_| {}).unwrap(),
                    path: "/tmp/b".to_string(),
                    stop: Arc::new(AtomicBool::new(false)),
                },
            );
        }
        state.remove_window("win-1");
        let map = state.watchers.lock().unwrap();
        assert!(!map.contains_key("win-1"));
        assert_eq!(map.get("win-2").map(|e| e.path.as_str()), Some("/tmp/b"));
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

    #[test]
    fn pending_changes_merge_same_path() {
        let mut pending = PendingChanges::default();
        pending.push("/ws/a.md".to_string(), "modify");
        pending.push("/ws/a.md".to_string(), "modify");
        pending.push("/ws/b.md".to_string(), "create");

        let mut batch = pending.drain();
        batch.sort();
        assert_eq!(
            batch,
            vec![
                ("/ws/a.md".to_string(), "modify"),
                ("/ws/b.md".to_string(), "create"),
            ]
        );
    }

    #[test]
    fn pending_changes_keep_structural_kind() {
        let mut pending = PendingChanges::default();
        pending.push("/ws/a.md".to_string(), "modify");
        pending.push("/ws/a.md".to_string(), "remove");
        // 结构变化优先，不会被随后的 modify 盖回去
        pending.push("/ws/a.md".to_string(), "modify");

        assert_eq!(pending.drain(), vec![("/ws/a.md".to_string(), "remove")]);
    }

    #[test]
    fn pending_changes_drain_empties_bucket() {
        let mut pending = PendingChanges::default();
        pending.push("/ws/a.md".to_string(), "modify");
        assert_eq!(pending.drain().len(), 1);
        assert!(pending.drain().is_empty());
    }

    #[test]
    fn is_ignored_skips_noise_components() {
        assert!(is_ignored(Path::new("/ws/.git/objects/ab/cd")));
        assert!(is_ignored(Path::new("C:/ws/node_modules/pkg/index.js")));
        assert!(is_ignored(Path::new("/ws/.DS_Store")));
        assert!(!is_ignored(Path::new("/ws/docs/readme.md")));
    }
}
