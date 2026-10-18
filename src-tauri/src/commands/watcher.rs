use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use notify::event::ModifyKind;
use notify::{Watcher, RecursiveMode, EventKind, RecommendedWatcher};
use crate::errors::{CommandError, ErrorCode};

/// 静默期（毫秒）：最后一次事件后安静这么久才发，`git checkout` 这类连续爆发
/// 会被整段合并成一批。
const DEBOUNCE_QUIET_MS: u64 = 150;
/// 最长等待（毫秒）：持续爆发时不能无限攒着，到期强制发一批。
const DEBOUNCE_MAX_MS: u64 = 250;
/// 合并线程的检查间隔。
const DEBOUNCE_TICK_MS: u64 = 50;

/// 变更类型（序列化为前端已有的 `modify` / `create` / `rename` / `remove`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Modify,
    Create,
    Rename,
    Remove,
}

impl ChangeKind {
    /// 是否为结构变化（需要刷新文件树）
    fn is_structural(self) -> bool {
        !matches!(self, ChangeKind::Modify)
    }
}

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
/// 同一路径在一个窗口内可能连续收到 modify + create 等事件：
/// - 后到的结构变化覆盖先生（删除后重建 = create，重建后删除 = remove）；
/// - 但内容修改不会把已经出现的结构变化降级（create + modify 仍是 create）。
#[derive(Default)]
struct PendingChanges {
    events: HashMap<String, ChangeKind>,
    /// 本批首个 / 最后一个事件的时间，用于判断静默期与最长等待
    oldest: Option<Instant>,
    last: Option<Instant>,
}

impl PendingChanges {
    fn push(&mut self, path: String, kind: ChangeKind) {
        let now = Instant::now();
        self.oldest.get_or_insert(now);
        self.last = Some(now);
        match self.events.get_mut(&path) {
            Some(existing) if kind == ChangeKind::Modify && existing.is_structural() => {}
            Some(existing) => *existing = kind,
            None => {
                self.events.insert(path, kind);
            }
        }
    }

    /// 到达静默期或最长等待时取走本批（否则返回空）。
    fn take_batch(&mut self, now: Instant) -> Vec<(String, ChangeKind)> {
        let (Some(oldest), Some(last)) = (self.oldest, self.last) else {
            return Vec::new();
        };
        let quiet = now.saturating_duration_since(last) >= Duration::from_millis(DEBOUNCE_QUIET_MS);
        let overdue =
            now.saturating_duration_since(oldest) >= Duration::from_millis(DEBOUNCE_MAX_MS);
        if !quiet && !overdue {
            return Vec::new();
        }
        self.oldest = None;
        self.last = None;
        self.events.drain().collect()
    }
}

/// 是否属于文件树同样忽略的噪音（`.git` / `node_modules` 等）。
///
/// 只看**相对监听根**的部分：工作区本身可能就位于名为 `node_modules` 的目录下，
/// 不能因为祖先目录名而把整个工作区的事件吞掉。
fn is_ignored(root: &Path, path: &Path) -> bool {
    let relative = path.strip_prefix(root).unwrap_or(path);
    relative.components().any(|component| {
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
    pub kind: ChangeKind,
}

/// 把 notify 事件类别归类为前端可用的 kind。
/// 返回 None 表示不关心的事件（访问、只读打开等）。
fn classify_event(kind: &EventKind) -> Option<ChangeKind> {
    match kind {
        EventKind::Create(_) => Some(ChangeKind::Create),
        EventKind::Remove(_) => Some(ChangeKind::Remove),
        // 重命名在 notify 中属于 Modify(Name(..))，对文件树而言是结构变化，
        // 必须单独归类，否则外部重命名会被当成内容修改而漏刷新。
        EventKind::Modify(ModifyKind::Name(_)) => Some(ChangeKind::Rename),
        EventKind::Modify(_) => Some(ChangeKind::Modify),
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
    let watch_root = watch_path.clone();
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
            if is_ignored(&watch_root, p) {
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

    // 先保存本窗口的 watcher（顶掉该窗口的旧实例，不影响其它窗口）。
    // 必须在起合并线程之前完成：加锁失败时直接返回，避免留下一个无人管理的线程。
    {
        let mut map = state
            .watchers
            .lock()
            .map_err(|e| CommandError::internal(format!("watcher lock: {e}")))?;
        map.insert(
            label.clone(),
            WatcherEntry {
                watcher,
                path,
                stop: Arc::clone(&stop),
            },
        );
    }

    // 合并线程：静默 150ms 或攒满 250ms 时，把桶里的变更按路径各发一条。
    // 事件只发给本窗口：裸 `emit` 是广播，多窗口下所有窗口都会收到
    // 别的窗口工作区的变更通知（前端虽按 workspacePath 过滤，但仍是无谓的
    // 跨窗口噪音，且同目录多窗口时会互相触发重载）。
    let flusher_pending = Arc::clone(&pending);
    let flusher_stop = Arc::clone(&stop);
    let flusher_app = app.clone();
    let flusher_label = label;
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(DEBOUNCE_TICK_MS));
        // 停掉之后不再发：避免切换工作区时把旧目录的尾巴事件送到新工作区
        if flusher_stop.load(Ordering::Relaxed) {
            break;
        }
        let batch = match flusher_pending.lock() {
            Ok(mut changes) => changes.take_batch(Instant::now()),
            Err(poisoned) => poisoned.into_inner().take_batch(Instant::now()),
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
    });

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
            Some(ChangeKind::Create)
        );
        assert_eq!(
            classify_event(&EventKind::Remove(RemoveKind::File)),
            Some(ChangeKind::Remove)
        );
        // 重命名是结构变化，不能被归类为 modify
        assert_eq!(
            classify_event(&EventKind::Modify(ModifyKind::Name(RenameMode::Both))),
            Some(ChangeKind::Rename)
        );
    }

    #[test]
    fn test_classify_content_modify() {
        assert_eq!(
            classify_event(&EventKind::Modify(ModifyKind::Data(DataChange::Content))),
            Some(ChangeKind::Modify)
        );
        assert_eq!(
            classify_event(&EventKind::Modify(ModifyKind::Any)),
            Some(ChangeKind::Modify)
        );
    }

    #[test]
    fn change_kind_serializes_to_frontend_strings() {
        // 前端按 modify / create / rename / remove 分支，序列化不能变
        let json = serde_json::to_string(&ChangeKind::Rename).unwrap();
        assert_eq!(json, "\"rename\"");
    }

    #[test]
    fn test_classify_ignored_events() {
        assert_eq!(classify_event(&EventKind::Access(notify::event::AccessKind::Read)), None);
        assert_eq!(classify_event(&EventKind::Other), None);
    }

    fn batch_of(pending: &mut PendingChanges) -> Vec<(String, ChangeKind)> {
        let mut batch = pending.take_batch(Instant::now() + Duration::from_secs(1));
        batch.sort_by(|a, b| a.0.cmp(&b.0));
        batch
    }

    #[test]
    fn pending_changes_merge_same_path() {
        let mut pending = PendingChanges::default();
        pending.push("/ws/a.md".to_string(), ChangeKind::Modify);
        pending.push("/ws/a.md".to_string(), ChangeKind::Modify);
        pending.push("/ws/b.md".to_string(), ChangeKind::Create);

        assert_eq!(
            batch_of(&mut pending),
            vec![
                ("/ws/a.md".to_string(), ChangeKind::Modify),
                ("/ws/b.md".to_string(), ChangeKind::Create),
            ]
        );
    }

    #[test]
    fn pending_changes_keep_structural_kind() {
        let mut pending = PendingChanges::default();
        pending.push("/ws/a.md".to_string(), ChangeKind::Modify);
        pending.push("/ws/a.md".to_string(), ChangeKind::Remove);
        // 结构变化不会被随后的 modify 降级
        pending.push("/ws/a.md".to_string(), ChangeKind::Modify);

        assert_eq!(
            batch_of(&mut pending),
            vec![("/ws/a.md".to_string(), ChangeKind::Remove)]
        );
    }

    #[test]
    fn pending_changes_follow_structural_order() {
        // 删除后重建 → create；重建后删除 → remove（后到的结构事件说了算）
        let mut pending = PendingChanges::default();
        pending.push("/ws/a.md".to_string(), ChangeKind::Remove);
        pending.push("/ws/a.md".to_string(), ChangeKind::Create);
        assert_eq!(
            batch_of(&mut pending),
            vec![("/ws/a.md".to_string(), ChangeKind::Create)]
        );

        let mut pending = PendingChanges::default();
        pending.push("/ws/a.md".to_string(), ChangeKind::Create);
        pending.push("/ws/a.md".to_string(), ChangeKind::Remove);
        assert_eq!(
            batch_of(&mut pending),
            vec![("/ws/a.md".to_string(), ChangeKind::Remove)]
        );
    }

    #[test]
    fn pending_changes_wait_for_quiet_or_max() {
        let mut pending = PendingChanges::default();
        pending.push("/ws/a.md".to_string(), ChangeKind::Modify);
        let now = Instant::now();
        // 刚收到事件：既不安静也没到期
        assert!(pending.take_batch(now).is_empty());
        // 超过最长等待：强制发一批
        assert_eq!(
            pending.take_batch(now + Duration::from_millis(DEBOUNCE_MAX_MS + 1)),
            vec![("/ws/a.md".to_string(), ChangeKind::Modify)]
        );
        assert!(pending.take_batch(now + Duration::from_secs(5)).is_empty());
    }

    #[test]
    fn is_ignored_skips_noise_components() {
        let root = Path::new("/ws");
        assert!(is_ignored(root, Path::new("/ws/.git/objects/ab/cd")));
        assert!(is_ignored(root, Path::new("/ws/node_modules/pkg/index.js")));
        assert!(is_ignored(root, Path::new("/ws/.DS_Store")));
        assert!(!is_ignored(root, Path::new("/ws/docs/readme.md")));
    }

    #[test]
    fn is_ignored_only_checks_path_below_root() {
        // 工作区本身位于 node_modules 下：不能因为祖先目录名吞掉所有事件
        let root = Path::new("/repo/node_modules/pkg");
        assert!(!is_ignored(root, Path::new("/repo/node_modules/pkg/docs/a.md")));
        assert!(is_ignored(
            root,
            Path::new("/repo/node_modules/pkg/node_modules/dep/index.js")
        ));
    }
}
