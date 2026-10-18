//! 路径访问策略（#437）。
//!
//! 命令层不再接受任意绝对路径：只有落在**已授权根**（工作区 / APPDATA）里的路径，
//! 或用户通过对话框 / 系统入口明确选中的单个文件，才允许读写删复制。
//! 授权只发生在可信入口（Rust 侧对话框、系统拖放、命令行 / 文件关联、启动恢复），
//! 渲染进程无法自行扩大白名单。
//!
//! 白名单不持久化：每次启动按 APPDATA 里的 `settings.json` / `recent.json` /
//! `tabs.json` 重新授权上次会话用到的路径（asset scope 同样如此）。

use std::path::{Component, Path, PathBuf};
use std::sync::{OnceLock, RwLock};

use tauri::Manager;

use crate::errors::{CommandError, ErrorCode};

/// 授权目录：命令白名单 + asset 协议（预览 / 导出要读本地图片）。
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

/// 授权单个文件：命令白名单 + asset 协议，并放行其所在目录（同目录相对图片）。
pub fn grant_file(app: &tauri::AppHandle, path: impl AsRef<Path>) {
    let path = path.as_ref();
    policy().allow_file(path);
    let _ = app.asset_protocol_scope().allow_file(path);
    if let Some(parent) = path.parent() {
        let _ = app.asset_protocol_scope().allow_directory(parent, true);
    }
}

/// 进程级路径白名单。
#[derive(Default)]
pub struct PathPolicy {
    /// 目录根（含其全部子路径）
    roots: RwLock<Vec<String>>,
    /// 单个文件（用户选中的、不在已授权根内的文件）
    files: RwLock<Vec<String>>,
}

static POLICY: OnceLock<PathPolicy> = OnceLock::new();

/// 全局策略实例（单进程桌面应用，无需按窗口隔离）。
pub fn policy() -> &'static PathPolicy {
    POLICY.get_or_init(PathPolicy::default)
}

impl PathPolicy {
    /// 授权一个目录（含子目录）。
    pub fn allow_root(&self, path: impl AsRef<Path>) {
        push_unique(&self.roots, key(path.as_ref()));
    }

    /// 授权单个文件。
    pub fn allow_file(&self, path: impl AsRef<Path>) {
        push_unique(&self.files, key(path.as_ref()));
    }

    /// 路径是否已授权。
    pub fn is_allowed(&self, path: &Path) -> bool {
        let target = key(path);
        if self
            .roots
            .read()
            .map(|roots| roots.iter().any(|root| is_under(root, &target)))
            .unwrap_or(false)
        {
            return true;
        }
        self.files
            .read()
            .map(|files| files.iter().any(|file| *file == target))
            .unwrap_or(false)
    }

    /// 未授权时返回 `outside_workspace`（不区分「不存在」，避免泄露文件系统信息）。
    pub fn ensure(&self, path: impl AsRef<Path>) -> Result<(), CommandError> {
        let path = path.as_ref();
        if self.is_allowed(path) {
            Ok(())
        } else {
            Err(CommandError::path(ErrorCode::OutsideWorkspace, path))
        }
    }
}

fn push_unique(list: &RwLock<Vec<String>>, value: String) {
    let mut guard = match list.write() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if !guard.iter().any(|item| *item == value) {
        guard.push(value);
    }
}

/// 路径归一化后的比较键：解析符号链接 / `..`，统一分隔符，Windows 下忽略大小写。
fn key(path: &Path) -> String {
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
    target == root
        || target
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// 启动时按上次会话的持久化状态重新授权（asset scope 不持久化）。
///
/// 数据来源都在 APPDATA 内：`settings.json`（上次工作区）、`recent.json`（最近打开）、
/// `tabs.json`（各窗口恢复的标签）。读取失败时静默跳过，不影响启动。
pub fn seed_from_persistence() {
    let Some(base) = dirs::data_dir() else {
        return;
    };
    // 应用自身的设置 / 草稿 / 日志都写在这里，始终放行
    policy().allow_root(&base);

    let app_dir = base.join("com.murasaki.app");
    if let Some(state) = read_json(&app_dir.join("settings.json")).get("state") {
        if let Some(path) = state.get("lastWorkspacePath").and_then(|v| v.as_str()) {
            policy().allow_root(path);
        }
    }

    if let Some(entries) = read_json(&app_dir.join("recent.json"))
        .get("entries")
        .and_then(|v| v.as_array())
    {
        for entry in entries {
            let path = entry.get("path").and_then(|v| v.as_str());
            let kind = entry.get("type").and_then(|v| v.as_str());
            if let Some(path) = path {
                if kind == Some("folder") {
                    policy().allow_root(path);
                } else {
                    policy().allow_file(path);
                }
            }
        }
    }

    if let Some(stores) = read_json(&app_dir.join("tabs.json")).as_object() {
        for value in stores.values() {
            let Some(tabs) = value.get("tabs").and_then(|v| v.as_array()) else {
                continue;
            };
            for tab in tabs {
                if let Some(path) = tab.get("path").and_then(|v| v.as_str()) {
                    policy().allow_file(path);
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

/// E2E：允许测试夹具目录与临时目录（测试通过 Pinia 直接指定工作区，不经过对话框）。
pub fn seed_e2e_roots() {
    if !crate::is_e2e_mode() {
        return;
    }
    if let Ok(cwd) = std::env::current_dir() {
        policy().allow_root(cwd.join("e2e").join(".workspace"));
    }
    policy().allow_root(std::env::temp_dir());
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

        assert!(policy.is_allowed(&nested));
        assert!(policy.is_allowed(&root.join("not-created-yet.md")));
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

        assert!(!policy.is_allowed(&sibling.join("x.md")));
        let err = policy.ensure(&sibling.join("x.md")).unwrap_err();
        assert_eq!(err.code, ErrorCode::OutsideWorkspace);

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&sibling);
    }

    #[test]
    fn rejects_parent_escape() {
        let root = temp_root();
        let policy = PathPolicy::default();
        policy.allow_root(&root);

        assert!(!policy.is_allowed(&root.join("..").join("escape.md")));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn allows_individually_registered_file_only() {
        let root = temp_root();
        let file = root.join("picked.md");
        std::fs::write(&file, "x").unwrap();

        let policy = PathPolicy::default();
        policy.allow_file(&file);

        assert!(policy.is_allowed(&file));
        assert!(!policy.is_allowed(&root.join("other.md")));

        let _ = std::fs::remove_dir_all(&root);
    }
}
