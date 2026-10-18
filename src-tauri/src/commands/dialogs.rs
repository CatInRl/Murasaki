//! 文件/文件夹选择对话框（#437）。
//!
//! 对话框放在 Rust 侧而不是让前端直接调 `plugin-dialog`，是为了把握手点收在可信进程里：
//! 用户选中的路径**当场**写入路径白名单（命令 + asset scope），渲染进程无法凭空扩大
//! 访问范围。前端只拿返回值。

use serde::Deserialize;
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::errors::CommandError;
use crate::security;

/// 对话框选项（与前端 `pick_file` / `pick_save` / `pick_folder` 的参数对齐）
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDialogOptions {
    pub title: Option<String>,
    /// 起始目录或文件名
    pub default_path: Option<String>,
    pub filters: Option<Vec<FileFilterOption>>,
}

#[derive(Debug, Deserialize)]
pub struct FileFilterOption {
    pub name: String,
    pub extensions: Vec<String>,
}

/// 构造对话框公共部分
fn builder(
    app: &AppHandle,
    window: &WebviewWindow,
    options: FileDialogOptions,
) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    let mut dialog = app.dialog().file().set_parent(window);
    if let Some(title) = options.title {
        dialog = dialog.set_title(title);
    }
    if let Some(default_path) = options.default_path {
        let p = std::path::PathBuf::from(&default_path);
        if p.is_dir() {
            dialog = dialog.set_directory(&p);
        } else {
            if let Some(name) = p.file_name() {
                dialog = dialog.set_file_name(name.to_string_lossy().to_string());
            }
            if let Some(parent) = p.parent() {
                dialog = dialog.set_directory(parent);
            }
        }
    }
    for filter in options.filters.unwrap_or_default() {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(filter.name, &extensions);
    }
    dialog
}

/// 三种选择模式共享「弹窗 → 拿到路径 → 当场授权」的流程
#[derive(Clone, Copy)]
enum PickMode {
    File,
    Save,
    Folder,
}

async fn pick(
    window: WebviewWindow,
    app: AppHandle,
    mode: PickMode,
    options: Option<FileDialogOptions>,
) -> Result<Option<String>, CommandError> {
    let dialog = builder(&app, &window, options.unwrap_or_default());
    let picked = tauri::async_runtime::spawn_blocking(move || match mode {
        PickMode::File => dialog.blocking_pick_file(),
        PickMode::Save => dialog.blocking_save_file(),
        PickMode::Folder => dialog.blocking_pick_folder(),
    })
    .await
    .map_err(|e| CommandError::internal(format!("file dialog join: {e}")))?;
    let Some(selected) = picked else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|e| CommandError::internal(format!("file dialog path: {e}")))?;
    match mode {
        PickMode::Folder => security::grant_dir(&app, &path),
        PickMode::File | PickMode::Save => security::grant_file(&app, &path),
    }
    Ok(Some(path.to_string_lossy().to_string()))
}

/// 选择单个文件；选中后授权该文件（读写 + 同目录只读）。
#[tauri::command]
pub async fn pick_file(
    window: WebviewWindow,
    app: AppHandle,
    options: Option<FileDialogOptions>,
) -> Result<Option<String>, CommandError> {
    pick(window, app, PickMode::File, options).await
}

/// 选择保存位置；选中后授权目标文件（可尚不存在）的写入。
#[tauri::command]
pub async fn pick_save(
    window: WebviewWindow,
    app: AppHandle,
    options: Option<FileDialogOptions>,
) -> Result<Option<String>, CommandError> {
    pick(window, app, PickMode::Save, options).await
}

/// 选择文件夹；选中后授权该目录（工作区根）。
#[tauri::command]
pub async fn pick_folder(
    window: WebviewWindow,
    app: AppHandle,
    options: Option<FileDialogOptions>,
) -> Result<Option<String>, CommandError> {
    pick(window, app, PickMode::Folder, options).await
}
