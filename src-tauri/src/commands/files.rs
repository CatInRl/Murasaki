use super::atomic_write::write_atomic;
use crate::errors::{CommandError, ErrorCode};
use crate::security::policy;
use lexical_sort::natural_lexical_cmp;
use pinyin::ToPinyin;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// 文件树节点：与前端 TreeNode 类型对齐
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub node_type: String, // "file" | "directory"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeNode>>,
    /// 文件大小（字节）；目录为 None。用于"无后缀文本"阈值判断与图标分类
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// spec：文件树默认隐藏以下已知噪音
///   版本控制目录：.git/ .svn/ .hg/
///   系统文件：    .DS_Store  Thumbs.db
///   依赖目录：    node_modules/
/// "显示隐藏文件"开关开启后才展示全部（含上述项与其他 dotfile）。
const NOISE_NAMES: &[&str] = &[
    ".git",
    ".svn",
    ".hg",
    ".DS_Store",
    "Thumbs.db",
    "node_modules",
];

pub(crate) fn is_noise(name: &str) -> bool {
    NOISE_NAMES.contains(&name)
}

/// 是否展示该条目：show_hidden=false 时过滤 NOISE_NAMES 清单与 dotfile
fn is_visible_name(name: &str, show_hidden: bool) -> bool {
    show_hidden || !(is_noise(name) || name.starts_with('.'))
}

/// 目录下是否还有会展示的子项（到达深度上限时用来判断「是否真的截断」）
fn has_visible_children(dir: &Path, show_hidden: bool) -> bool {
    fs::read_dir(dir)
        .map(|entries| {
            entries.flatten().any(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                is_visible_name(&name, show_hidden)
            })
        })
        .unwrap_or(false)
}

/// 排序键：按"数字 → 英文 → 中文 → 其他"分组，组内自然序
fn category_of(s: &str) -> u8 {
    let c = s.chars().next().unwrap_or(' ');
    if c.is_ascii_digit() {
        0
    } else if c.is_ascii_alphabetic() {
        1
    } else if ('\u{4E00}'..='\u{9FFF}').contains(&c) {
        2
    } else {
        3
    }
}

/// 中文拼音排序：取首字符拼音 plain 形式比较，无法识别时回退到原字符串小写
fn pinyin_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let pa = a
        .to_pinyin()
        .next()
        .flatten()
        .map(|p| p.plain().to_string())
        .unwrap_or_else(|| a.to_lowercase());
    let pb = b
        .to_pinyin()
        .next()
        .flatten()
        .map(|p| p.plain().to_string())
        .unwrap_or_else(|| b.to_lowercase());
    pa.cmp(&pb)
}

/// zh-CN locale-aware 自然排序：
///   1. 目录优先于文件
///   2. 同优先级内按字符类别分组：数字 → 英文 → 中文 → 其他
///   3. 组内排序：数字自然序、英文大小写不敏感字母序、中文拼音序、其他 Unicode 码点序
fn sort_tree_nodes(nodes: &mut [TreeNode]) {
    nodes.sort_by(|a, b| {
        // 1. 目录优先
        let da = a.node_type == "directory";
        let db = b.node_type == "directory";
        if da != db {
            return db.cmp(&da);
        }
        // 2. 同类型（文件）：Markdown 优先
        if !da {
            let a_md = is_markdown(&a.name);
            let b_md = is_markdown(&b.name);
            if a_md != b_md {
                return b_md.cmp(&a_md);
            }
        }
        // 3. 字符类别分组
        let ca = category_of(&a.name);
        let cb = category_of(&b.name);
        if ca != cb {
            return ca.cmp(&cb);
        }
        // 4. 组内排序
        match ca {
            0 => natural_lexical_cmp(&a.name, &b.name), // 数字自然序
            1 => a.name.to_lowercase().cmp(&b.name.to_lowercase()), // 英文字母序（大小写不敏感）
            2 => pinyin_cmp(&a.name, &b.name),          // 中文拼音序
            _ => a.name.cmp(&b.name),                   // 其他 Unicode 码点序
        }
    });
}

fn is_markdown(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".md")
        || lower.ends_with(".markdown")
        || lower.ends_with(".mdown")
        || lower.ends_with(".mkd")
}

/// 文件树递归深度上限（根目录为第 0 层）。
/// 达到该层时仍返回目录节点，但不再展开其子目录。
pub const MAX_TREE_DEPTH: usize = 20;

/// 文件树节点总数上限：超过后停止遍历并返回 `truncated = true`。
///
/// 20k 节点足够覆盖正常项目；再大的目录（含依赖、产物、网络盘）一次整棵树
/// 返回既拖垮后端遍历，也让前端一次渲染卡死。
pub const MAX_TREE_NODES: usize = 20_000;

/// 文件树遍历配额：节点数与截断标记（#432）
struct TreeBudget {
    remaining: usize,
    truncated: bool,
}

impl TreeBudget {
    fn new(limit: usize) -> Self {
        Self {
            remaining: limit,
            truncated: false,
        }
    }

    /// 申请一个节点配额；耗尽时标记截断并返回 false
    fn take(&mut self) -> bool {
        if self.remaining == 0 {
            self.truncated = true;
            return false;
        }
        self.remaining -= 1;
        true
    }
}

/// `list_tree` 的返回：节点列表 + 是否因上限被截断（#432）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeListing {
    pub nodes: Vec<TreeNode>,
    /// 因深度或节点数上限而省略了部分内容
    pub truncated: bool,
}

/// 递归遍历目录生成文件树
/// show_hidden: 是否显示全部（含 NOISE_NAMES 清单与 dotfile）；false 时按 spec 过滤噪音 + dotfile
fn build_tree_inner(
    dir: &Path,
    show_hidden: bool,
    depth: usize,
    budget: &mut TreeBudget,
) -> std::io::Result<Vec<TreeNode>> {
    let mut nodes: Vec<TreeNode> = Vec::new();
    let entries = fs::read_dir(dir)?;

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        // 默认（show_hidden=false）：
        //   - 跳过 spec 列出的噪音项（.git/.svn/.hg/.DS_Store/Thumbs.db/node_modules）
        //   - 跳过其他 dotfile（以 . 开头）
        if !is_visible_name(&name, show_hidden) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if metadata.is_dir() {
            if !budget.take() {
                break;
            }
            // 达到深度上限：保留目录节点但不再展开；只有确实还有内容时才算截断
            let children = if depth + 1 >= MAX_TREE_DEPTH {
                if has_visible_children(&path, show_hidden) {
                    budget.truncated = true;
                }
                Vec::new()
            } else {
                match build_tree_inner(&path, show_hidden, depth + 1, budget) {
                    Ok(children) => children,
                    Err(_) => {
                        // 子目录不可读：内容确实缺失，标记截断让用户知道
                        budget.truncated = true;
                        Vec::new()
                    }
                }
            };
            nodes.push(TreeNode {
                name,
                path: path.to_string_lossy().to_string(),
                node_type: "directory".to_string(),
                children: Some(children),
                size: None,
            });
        } else {
            if !budget.take() {
                break;
            }
            let size = entry.metadata().ok().map(|m| m.len());
            nodes.push(TreeNode {
                name,
                path: path.to_string_lossy().to_string(),
                node_type: "file".to_string(),
                children: None,
                size,
            });
        }
    }

    sort_tree_nodes(&mut nodes);
    Ok(nodes)
}

/// 列出指定目录的文件树（递归，一次返回完整结构）
/// show_hidden: 可选，是否包含隐藏文件（默认 false）
///
/// #432：改为 `async` + `spawn_blocking`，避免递归遍历大目录时阻塞主线程；
/// 超过深度 / 节点数上限时返回 `truncated = true`。
#[tauri::command]
pub async fn list_tree(
    path: String,
    show_hidden: Option<bool>,
) -> Result<TreeListing, CommandError> {
    policy().ensure_read(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = PathBuf::from(&path);
        if !dir.exists() {
            return Err(CommandError::path(ErrorCode::NotFound, &path));
        }
        if !dir.is_dir() {
            return Err(CommandError::path(ErrorCode::NotADirectory, &path));
        }
        let mut budget = TreeBudget::new(MAX_TREE_NODES);
        let nodes = build_tree_inner(&dir, show_hidden.unwrap_or(false), 0, &mut budget)
            .map_err(|e| CommandError::io_at(&e, &path))?;
        Ok(TreeListing {
            nodes,
            truncated: budget.truncated,
        })
    })
    .await
    .map_err(|e| CommandError::internal(format!("list_tree join: {e}")))?
}

/// 创建文件（若已存在则报错）
#[tauri::command]
pub fn create_file(path: String) -> Result<TreeNode, CommandError> {
    policy().ensure_write(&path)?;
    let p = PathBuf::from(&path);
    if p.exists() {
        return Err(CommandError::path(ErrorCode::AlreadyExists, &path));
    }
    // 确保父目录存在
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| CommandError::io_at(&e, parent))?;
    }
    fs::File::create(&p).map_err(|e| CommandError::io_at(&e, &path))?;
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(TreeNode {
        name,
        path: p.to_string_lossy().to_string(),
        node_type: "file".to_string(),
        children: None,
        size: Some(0),
    })
}

/// 创建目录（若已存在则报错）
#[tauri::command]
pub fn create_directory(path: String) -> Result<TreeNode, CommandError> {
    policy().ensure_write(&path)?;
    let p = PathBuf::from(&path);
    if p.exists() {
        return Err(CommandError::path(ErrorCode::AlreadyExists, &path));
    }
    fs::create_dir_all(&p).map_err(|e| CommandError::io_at(&e, &path))?;
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(TreeNode {
        name,
        path: p.to_string_lossy().to_string(),
        node_type: "directory".to_string(),
        children: Some(Vec::new()),
        size: None,
    })
}

/// 删除文件或目录（走系统回收站）
#[tauri::command]
pub fn delete_path(path: String) -> Result<(), CommandError> {
    policy().ensure_write(&path)?;
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(CommandError::path(ErrorCode::NotFound, &path));
    }
    trash::delete(&p).map_err(|e| {
        // Windows 下 `Error::Os` 的 code 是 Win32 错误码（5 = ERROR_ACCESS_DENIED）；
        // `CouldNotAccess` 在路径存在性已检查过之后只剩权限问题。
        let code = match &e {
            trash::Error::Os { code: 5, .. } | trash::Error::CouldNotAccess { .. } => {
                ErrorCode::PermissionDenied
            }
            _ => ErrorCode::Internal,
        };
        CommandError::path(code, &path).with_param("detail", format!("trash: {e}"))
    })
}

/// 重命名/移动文件或目录
#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<TreeNode, CommandError> {
    policy().ensure_write(&from)?;
    policy().ensure_write(&to)?;
    let src = PathBuf::from(&from);
    let dst = PathBuf::from(&to);
    if !src.exists() {
        return Err(CommandError::path(ErrorCode::NotFound, &from));
    }
    if dst.exists() {
        return Err(CommandError::path(ErrorCode::AlreadyExists, &to));
    }
    // 确保目标父目录存在
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| CommandError::io_at(&e, parent))?;
    }
    fs::rename(&src, &dst)
        .map_err(|e| CommandError::io_at(&e, &from).with_param("to", to.clone()))?;
    let name = dst
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let node_type = if dst.is_dir() { "directory" } else { "file" };
    Ok(TreeNode {
        name,
        path: dst.to_string_lossy().to_string(),
        node_type: node_type.to_string(),
        children: None,
        size: None,
    })
}

/// 复制文件（仅文件，不复制目录）
#[tauri::command]
pub fn copy_file(from: String, to: String) -> Result<TreeNode, CommandError> {
    policy().ensure_write(&from)?;
    policy().ensure_write(&to)?;
    let src = PathBuf::from(&from);
    let dst = PathBuf::from(&to);
    if !src.exists() {
        return Err(CommandError::path(ErrorCode::NotFound, &from));
    }
    if dst.exists() {
        return Err(CommandError::path(ErrorCode::AlreadyExists, &to));
    }
    if src.is_dir() {
        return Err(
            CommandError::new(ErrorCode::Unsupported).with_param("operation", "copy_directory")
        );
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| CommandError::io_at(&e, parent))?;
    }
    fs::copy(&src, &dst)
        .map_err(|e| CommandError::io_at(&e, &from).with_param("to", to.clone()))?;
    let name = dst
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let size = fs::metadata(&dst).ok().map(|m| m.len());
    Ok(TreeNode {
        name,
        path: dst.to_string_lossy().to_string(),
        node_type: "file".to_string(),
        children: None,
        size,
    })
}

/// 读取文件内容（文本）
///
/// #432：`async` + `spawn_blocking` —— 大文件或网络盘读取不再占用主线程。
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, CommandError> {
    policy().ensure_read(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        fs::read_to_string(&path).map_err(|e| CommandError::io_at(&e, &path))
    })
    .await
    .map_err(|e| CommandError::internal(format!("read_text_file join: {e}")))?
}

/// 读取文件内容（二进制，返回字节数组）
/// 用于 HTML 导出时将图片转为 Base64
///
/// #432：`async` + `spawn_blocking`。
#[tauri::command]
pub async fn read_binary_file(path: String) -> Result<Vec<u8>, CommandError> {
    policy().ensure_read(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        fs::read(&path).map_err(|e| CommandError::io_at(&e, &path))
    })
    .await
    .map_err(|e| CommandError::internal(format!("read_binary_file join: {e}")))?
}

/// 写入文件内容（文本）
///
/// #432：`async` + `spawn_blocking` —— 原子替换含 fsync，大文件写盘不再阻塞主线程。
#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), CommandError> {
    policy().ensure_write(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        write_atomic(Path::new(&path), content.as_bytes())
            .map_err(|e| CommandError::io_at(&e, &path))
    })
    .await
    .map_err(|e| CommandError::internal(format!("write_text_file join: {e}")))?
}

/// 检查路径是否存在
#[tauri::command]
pub fn path_exists(path: String) -> Result<bool, CommandError> {
    policy().ensure_read(&path)?;
    Ok(Path::new(&path).exists())
}

/// 获取路径类型："file" | "directory" | "none"
#[tauri::command]
pub fn path_type(path: String) -> Result<String, CommandError> {
    policy().ensure_read(&path)?;
    let p = Path::new(&path);
    if p.is_file() {
        Ok("file".to_string())
    } else if p.is_dir() {
        Ok("directory".to_string())
    } else {
        Ok("none".to_string())
    }
}

/// 获取文件大小（字节）
///
/// 前端用它决定「无后缀文件是否大到打开前先确认」（issue #308）—— 判断必须在
/// 读取**之前**做，否则几百 MB 的文件已经把内容读进内存了。
#[tauri::command]
pub fn get_file_size(path: String) -> Result<u64, CommandError> {
    policy().ensure_read(&path)?;
    let p = Path::new(&path);
    if !p.exists() {
        return Err(CommandError::path(ErrorCode::NotFound, &path));
    }
    let metadata = fs::metadata(p).map_err(|e| CommandError::io_at(&e, &path))?;
    Ok(metadata.len())
}

/// 在系统资源管理器中显示文件（Windows: explorer.exe /select,）
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), CommandError> {
    policy().ensure_read(&path)?;
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(CommandError::path(ErrorCode::NotFound, &path));
    }
    #[cfg(target_os = "windows")]
    {
        // 使用 explorer.exe /select,"path"
        std::process::Command::new("explorer.exe")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| CommandError::internal(format!("explorer: {e}")))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| CommandError::internal(format!("open -R: {e}")))?;
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        // Linux: 打开父目录
        let parent = p.parent().unwrap_or(Path::new("."));
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| CommandError::internal(format!("xdg-open: {e}")))?;
    }
    Ok(())
}

/// 用系统默认程序打开文件或目录（应用打不开的文件的兜底出口，issue #307）
///
/// 不走 `plugin-shell` 的 `open`：能力集里的 `shell:default` 只放行 URL
/// （http(s) / `tel:` / `mailto:`），要打开本地路径得把 `allow-open` 的 scope 放宽到 `**`，
/// 为一个兜底入口扩大攻击面不划算。这里与 `reveal_in_explorer` 同形，用系统命令。
#[tauri::command]
pub fn open_with_default_app(path: String) -> Result<(), CommandError> {
    policy().ensure_read(&path)?;
    if !Path::new(&path).exists() {
        return Err(CommandError::path(ErrorCode::NotFound, &path));
    }
    #[cfg(target_os = "windows")]
    {
        // 用 explorer.exe 而不是 `cmd /c start`：两者都能「按默认程序打开」，但走 cmd 有两个坑 ——
        // ① 文件名里的 `&` `^` `%` `(` 在无空格时不会被 Rust 加引号，会被 cmd 当元字符解释
        //    （拆命令 / 变量展开）；
        // ② cmd 是控制台程序，从 GUI 子进程（main.rs 的 windows_subsystem="windows"）里起
        //    会闪一下黑窗。
        // explorer.exe 不经 shell，且与同文件的 reveal_in_explorer 用同一个程序。
        std::process::Command::new("explorer.exe")
            .arg(&path)
            .spawn()
            .map_err(|e| CommandError::internal(format!("explorer: {e}")))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| CommandError::internal(format!("open: {e}")))?;
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| CommandError::internal(format!("xdg-open: {e}")))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 只测错误分支：成功分支会真的拉起系统程序，不适合放进测试
    #[test]
    fn open_with_default_app_rejects_unlisted_path() {
        let missing = if cfg!(windows) {
            "Z:\\definitely\\not\\here\\murasaki-307.txt"
        } else {
            "/definitely/not/here/murasaki-307.txt"
        };
        let err = open_with_default_app(missing.to_string()).unwrap_err();
        assert_eq!(
            err.code,
            ErrorCode::OutsideWorkspace,
            "unexpected error: {err}"
        );
    }

    #[test]
    fn get_file_size_returns_bytes() {
        let dir = std::env::temp_dir().join("murasaki-308-get-file-size");
        fs::create_dir_all(&dir).unwrap();
        crate::security::policy().allow_root(&dir);
        let file = dir.join("Makefile");
        let content = "all:\n\techo hi\n";
        fs::write(&file, content).unwrap();

        let size = get_file_size(file.to_string_lossy().to_string()).unwrap();
        assert_eq!(size, content.len() as u64);

        let _ = fs::remove_file(&file);
        let _ = fs::remove_dir(&dir);
    }

    #[test]
    fn get_file_size_rejects_unlisted_path() {
        let missing = if cfg!(windows) {
            "Z:\\definitely\\not\\here\\murasaki-308"
        } else {
            "/definitely/not/here/murasaki-308"
        };
        let err = get_file_size(missing.to_string()).unwrap_err();
        assert_eq!(
            err.code,
            ErrorCode::OutsideWorkspace,
            "unexpected error: {err}"
        );
    }

    #[test]
    fn create_file_rejects_path_outside_allowed_roots() {
        let outside = if cfg!(windows) {
            "Z:\\definitely\\not\\here\\murasaki-437.md"
        } else {
            "/definitely/not/here/murasaki-437.md"
        };
        let err = create_file(outside.to_string()).unwrap_err();
        assert_eq!(
            err.code,
            ErrorCode::OutsideWorkspace,
            "unexpected error: {err}"
        );
    }

    #[test]
    fn build_tree_inner_returns_err_when_dir_unreadable() {
        let file = std::env::temp_dir().join("murasaki-408-not-a-dir");
        let _ = fs::remove_file(&file);
        fs::write(&file, b"x").unwrap();
        let result = build_tree_inner(&file, false, 0, &mut TreeBudget::new(MAX_TREE_NODES));
        let _ = fs::remove_file(&file);
        assert!(
            result.is_err(),
            "issue #408: read_dir 失败必须返回 Err 而不是静默空树: {result:?}"
        );
    }

    #[test]
    fn build_tree_inner_lists_dir_and_filters_noise() {
        let dir = std::env::temp_dir().join("murasaki-408-build-tree");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.md"), "x").unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".git").join("config"), "x").unwrap();

        let hidden = build_tree_inner(&dir, true, 0, &mut TreeBudget::new(MAX_TREE_NODES)).unwrap();
        assert_eq!(hidden.len(), 2);

        let visible =
            build_tree_inner(&dir, false, 0, &mut TreeBudget::new(MAX_TREE_NODES)).unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].name, "a.md");

        let _ = fs::remove_dir_all(&dir);
    }

    /// #432：节点数超过上限时停止遍历并标记截断
    #[test]
    fn build_tree_inner_truncates_when_node_budget_exhausted() {
        let dir = std::env::temp_dir().join("murasaki-432-budget");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for i in 0..10 {
            fs::write(dir.join(format!("f{}.md", i)), "x").unwrap();
        }

        let mut budget = TreeBudget::new(3);
        let nodes = build_tree_inner(&dir, false, 0, &mut budget).unwrap();

        assert_eq!(nodes.len(), 3, "配额耗尽后必须停止追加节点");
        assert!(budget.truncated, "配额耗尽必须标记 truncated");

        let _ = fs::remove_dir_all(&dir);
    }

    /// #432：未超限时不得标记截断
    #[test]
    fn build_tree_inner_not_truncated_when_within_limits() {
        let dir = std::env::temp_dir().join("murasaki-432-no-truncate");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub").join("a.md"), "x").unwrap();

        let mut budget = TreeBudget::new(MAX_TREE_NODES);
        let nodes = build_tree_inner(&dir, false, 0, &mut budget).unwrap();

        assert_eq!(nodes.len(), 1);
        assert!(!budget.truncated, "未超限不得标记截断");

        let _ = fs::remove_dir_all(&dir);
    }

    /// #432：达到深度上限时保留目录节点但不再展开，并标记截断
    #[test]
    fn build_tree_inner_truncates_at_depth_limit() {
        let dir = std::env::temp_dir().join("murasaki-432-depth");
        let _ = fs::remove_dir_all(&dir);
        let nested = dir.join("a").join("b");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("deep.md"), "x").unwrap();

        // depth = MAX_TREE_DEPTH - 1：下一层目录不再展开
        let mut budget = TreeBudget::new(MAX_TREE_NODES);
        let nodes = build_tree_inner(&dir, false, MAX_TREE_DEPTH - 1, &mut budget).unwrap();

        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].node_type, "directory");
        assert_eq!(nodes[0].children.as_ref().map(|c| c.len()), Some(0));
        assert!(budget.truncated, "深度截断必须标记 truncated");

        let _ = fs::remove_dir_all(&dir);
    }

    /// #432：深度上限处的空目录（或只含噪音的目录）不算截断
    #[test]
    fn build_tree_inner_depth_limit_empty_dir_is_not_truncated() {
        let dir = std::env::temp_dir().join("murasaki-432-depth-empty");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("empty")).unwrap();
        fs::create_dir_all(dir.join("only-noise").join("node_modules")).unwrap();

        let mut budget = TreeBudget::new(MAX_TREE_NODES);
        let nodes = build_tree_inner(&dir, false, MAX_TREE_DEPTH - 1, &mut budget).unwrap();

        assert_eq!(nodes.len(), 2);
        assert!(!budget.truncated, "没有省略任何内容时不得标记截断");

        let _ = fs::remove_dir_all(&dir);
    }
}
