//! 路径访问策略（#437）。
//!
//! 命令层不再接受任意绝对路径：只有落在**已授权根**（工作区 / 应用数据目录）里的路径，
//! 或用户通过对话框 / 系统入口明确选中的文件，才允许读写删复制。
//! 授权只发生在可信入口（Rust 侧对话框、系统拖放、命令行 / 文件关联、启动恢复），
//! 渲染进程在本次运行期间无法自行扩大白名单；跨重启按 APPDATA 中的持久化状态
//! （settings / recent / tabs）重建上次会话的授权。
//!
//! 白名单不持久化：每次启动按 APPDATA 里的 `settings.json` / `recent.json` /
//! `tabs.json` 重新授权上次会话用到的路径（asset scope 同样如此）。

use std::path::{Component, Path, PathBuf};
use std::sync::{OnceLock, RwLock};

use tauri::Manager;

use crate::errors::{CommandError, ErrorCode};

/// 授权目录：命令白名单（读写）+ asset 协议（预览 / 导出要读本地图片）。
pub fn grant_dir(app: &tauri::AppHandle, path: impl AsRef<Path>) {
    let path = path.as_ref();
    policy().allow_root(path);
    let _ = app.asset_protocol_scope().allow_directory(path, true);
}

/// 按类型授权：目录 → 根，其它 → 单文件。用于系统入口（拖放 / 命令行 / 文件关联）。
pub fn grant_path(app: &tauri::AppHandle, path: &Path) {
    if path.is_dir() {
        grant_dir(app, path);
    } else {
        grant_file(app, path);
    }
}

/// 授权单个文件：可读写，并把它所在的目录列为**只读**（同目录图片、导出内联）。
pub fn grant_file(app: &tauri::AppHandle, path: impl AsRef<Path>) {
    let path = path.as_ref();
    policy().allow_file(path);
    let _ = app.asset_protocol_scope().allow_file(path);
    if let Some(parent) = path.parent() {
        policy().allow_read_root(parent);
        let _ = app.asset_protocol_scope().allow_directory(parent, true);
    }
}

/// 进程级路径白名单。
#[derive(Default)]
pub struct PathPolicy {
    /// 可读可写：工作区根、应用数据目录
    roots: RwLock<Vec<String>>,
    /// 只读：已打开文件所在目录（预览同目录图片 / 导出内联图片）
    read_roots: RwLock<Vec<String>>,
    /// 单个文件（用户选中的、不在已授权根内的文件）
    files: RwLock<Vec<String>>,
}

static POLICY: OnceLock<PathPolicy> = OnceLock::new();

/// 全局策略实例（单进程桌面应用，无需按窗口隔离）。
pub fn policy() -> &'static PathPolicy {
    POLICY.get_or_init(PathPolicy::default)
}

impl PathPolicy {
    /// 授权一个目录（读写，含子目录）。
    pub fn allow_root(&self, path: impl AsRef<Path>) {
        push_unique(&self.roots, comparison_key(path.as_ref()));
    }

    /// 授权一个目录（只读，含子目录）。
    pub fn allow_read_root(&self, path: impl AsRef<Path>) {
        push_unique(&self.read_roots, comparison_key(path.as_ref()));
    }

    /// 授权单个文件（读写）。
    pub fn allow_file(&self, path: impl AsRef<Path>) {
        push_unique(&self.files, comparison_key(path.as_ref()));
    }

    /// 是否允许写入（删除 / 重命名 / 复制目标）。
    pub fn can_write(&self, path: &Path) -> bool {
        let target = comparison_key(path);
        contains(&self.roots, &target) || contains(&self.files, &target)
    }

    /// 是否允许读取（含只读目录）。
    pub fn can_read(&self, path: &Path) -> bool {
        let target = comparison_key(path);
        contains(&self.roots, &target)
            || contains(&self.read_roots, &target)
            || contains(&self.files, &target)
    }

    /// 读写权限校验；未授权时返回 `outside_workspace`。
    pub fn ensure_write(&self, path: impl AsRef<Path>) -> Result<(), CommandError> {
        let path = path.as_ref();
        if self.can_write(path) {
            Ok(())
        } else {
            Err(CommandError::path(ErrorCode::OutsideWorkspace, path))
        }
    }

    /// 读权限校验；未授权时返回 `outside_workspace`。
    pub fn ensure_read(&self, path: impl AsRef<Path>) -> Result<(), CommandError> {
        let path = path.as_ref();
        if self.can_read(path) {
            Ok(())
        } else {
            Err(CommandError::path(ErrorCode::OutsideWorkspace, path))
        }
    }
}

fn contains(list: &RwLock<Vec<String>>, target: &str) -> bool {
    list.read()
        .map(|items| items.iter().any(|item| is_under(item, target)))
        .unwrap_or(false)
}

fn push_unique(list: &RwLock<Vec<String>>, value: String) {
    let mut guard = match list.write() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if !guard.contains(&value) {
        guard.push(value);
    }
}

/// 路径归一化后的比较键：解析符号链接 / `..`，统一分隔符，Windows 下忽略大小写。
fn comparison_key(path: &Path) -> String {
    let normalized = resolve(path).to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

/// 尽量解析为真实路径；目标尚不存在时，用其已存在的父目录作前缀。
fn resolve(path: &Path) -> PathBuf {
    if let Ok(resolved) = path.canonicalize() {
        return trim_verbatim(resolved);
    }
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        if !parent.as_os_str().is_empty() {
            if let Ok(resolved) = parent.canonicalize() {
                return lexical(&trim_verbatim(resolved).join(name));
            }
        }
    }
    lexical(path)
}

/// 去掉 Windows 的 `\\?\` 前缀，避免与用户输入 / 配置里的写法不一致。
fn trim_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

/// 词法归一：去掉 `.`、折叠 `..`（不访问文件系统）。
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `target` 是否等于 `root` 或位于其下（按路径分段比较，避免 `/a/bc` 命中 `/a/b`）。
fn is_under(root: &str, target: &str) -> bool {
    if target == root {
        return true;
    }
    let normalized_root = root.strip_suffix('/').unwrap_or(root);
    // 盘根（`c:`）与 Unix 根（空）都要能匹配
    if normalized_root.is_empty() {
        return target.starts_with('/');
    }
    target
        .strip_prefix(normalized_root)
        .is_some_and(|rest| rest.starts_with('/'))
}

/// 启动时按上次会话的持久化状态重新授权（asset scope 不持久化）。
///
/// 数据来源：应用的配置目录（`settings.json` / `recent.json` / `tabs.json`）与草稿目录。
/// 读取失败时静默跳过，不影响启动。
pub fn seed_from_persistence(app: &tauri::AppHandle) {
    // 设置 / 最近文件 / 标签 / 草稿：应用自身的数据，始终放行
    let config_dir = app.path().app_config_dir().ok();
    if let Some(dir) = &config_dir {
        grant_dir(app, dir);
    }
    if let Some(dir) = dirs::data_dir().map(|base| base.join("murasaki")) {
        grant_dir(app, &dir);
    }

    let Some(config_dir) = config_dir else {
        return;
    };

    if let Some(state) = read_json(&config_dir.join("settings.json")).get("state") {
        if let Some(path) = state.get("lastWorkspacePath").and_then(|v| v.as_str()) {
            grant_dir(app, path);
        }
    }

    if let Some(entries) = read_json(&config_dir.join("recent.json"))
        .get("entries")
        .and_then(|v| v.as_array())
    {
        for entry in entries {
            let path = entry.get("path").and_then(|v| v.as_str());
            let kind = entry.get("type").and_then(|v| v.as_str());
            if let Some(path) = path {
                if kind == Some("folder") {
                    grant_dir(app, path);
                } else {
                    grant_file(app, path);
                }
            }
        }
    }

    if let Some(stores) = read_json(&config_dir.join("tabs.json")).as_object() {
        for value in stores.values() {
            let Some(tabs) = value.get("tabs").and_then(|v| v.as_array()) else {
                continue;
            };
            for tab in tabs {
                if let Some(path) = tab.get("path").and_then(|v| v.as_str()) {
                    grant_file(app, path);
                }
            }
        }
    }
}

fn read_json(path: &Path) -> serde_json::Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(serde_json::Value::Null)
}

/// E2E：放行测试夹具目录与临时目录（测试通过 Pinia 直接指定工作区，不经过对话框）。
pub fn seed_e2e_roots(app: &tauri::AppHandle) {
    if !crate::is_e2e_mode() {
        return;
    }
    // 覆盖 e2e/.workspace 与各类 .workspace-* / fixtures；
    // 应用进程的 cwd 可能是仓库根，也可能是 src-tauri，向上找几层
    let mut dir = std::env::current_dir().ok();
    for _ in 0..3 {
        let Some(current) = dir else { break };
        let candidate = current.join("e2e");
        if candidate.is_dir() {
            grant_dir(app, &candidate);
            break;
        }
        dir = current.parent().map(Path::to_path_buf);
    }
    grant_dir(app, std::env::temp_dir());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "murasaki-policy-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn allows_paths_under_registered_root() {
        let root = temp_root();
        let nested = root.join("docs").join("a.md");
        std::fs::create_dir_all(nested.parent().unwrap()).unwrap();
        std::fs::write(&nested, "x").unwrap();

        let policy = PathPolicy::default();
        policy.allow_root(&root);

        assert!(policy.can_write(&nested));
        assert!(policy.can_write(&root.join("not-created-yet.md")));
    }

    #[test]
    fn rejects_sibling_with_shared_prefix() {
        let root = temp_root();
        let sibling = root.with_file_name(format!(
            "{}-sibling",
            root.file_name().unwrap().to_string_lossy()
        ));
        std::fs::create_dir_all(&sibling).unwrap();

        let policy = PathPolicy::default();
        policy.allow_root(&root);

        assert!(!policy.can_read(&sibling.join("x.md")));
        let err = policy.ensure_read(sibling.join("x.md")).unwrap_err();
        assert_eq!(err.code, ErrorCode::OutsideWorkspace);

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&sibling);
    }

    #[test]
    fn rejects_parent_escape() {
        let root = temp_root();
        let policy = PathPolicy::default();
        policy.allow_root(&root);

        assert!(!policy.can_read(&root.join("..").join("escape.md")));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn allows_individually_registered_file_only() {
        let root = temp_root();
        let file = root.join("picked.md");
        std::fs::write(&file, "x").unwrap();

        let policy = PathPolicy::default();
        policy.allow_file(&file);

        assert!(policy.can_write(&file));
        assert!(!policy.can_write(&root.join("other.md")));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_root_allows_reads_but_not_writes() {
        let dir = temp_root();
        let policy = PathPolicy::default();
        policy.allow_read_root(&dir);

        assert!(policy.can_read(&dir.join("img.png")));
        assert!(!policy.can_write(&dir.join("img.png")));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn drive_root_matches_everything_on_that_drive() {
        assert!(is_under("c:", "c:/users/a.md"));
        assert!(is_under("c:/", "c:/users/a.md"));
        assert!(!is_under("c:", "d:/users/a.md"));
        assert!(is_under("/", "/home/a.md"));
    }
}
