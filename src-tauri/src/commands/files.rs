use std::fs;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use lexical_sort::natural_lexical_cmp;
use pinyin::ToPinyin;

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

fn is_noise(name: &str) -> bool {
    NOISE_NAMES.iter().any(|n| *n == name)
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
    let pa = a.to_pinyin().next().flatten()
        .map(|p| p.plain().to_string())
        .unwrap_or_else(|| a.to_lowercase());
    let pb = b.to_pinyin().next().flatten()
        .map(|p| p.plain().to_string())
        .unwrap_or_else(|| b.to_lowercase());
    pa.cmp(&pb)
}

/// zh-CN locale-aware 自然排序：
///   1. 目录优先于文件
///   2. 同优先级内按字符类别分组：数字 → 英文 → 中文 → 其他
///   3. 组内排序：数字自然序、英文大小写不敏感字母序、中文拼音序、其他 Unicode 码点序
fn sort_tree_nodes(nodes: &mut Vec<TreeNode>) {
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
            0 => natural_lexical_cmp(&a.name, &b.name),        // 数字自然序
            1 => a.name.to_lowercase().cmp(&b.name.to_lowercase()), // 英文字母序（大小写不敏感）
            2 => pinyin_cmp(&a.name, &b.name),                 // 中文拼音序
            _ => a.name.cmp(&b.name),                          // 其他 Unicode 码点序
        }
    });
}

fn is_markdown(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".mdown") || lower.ends_with(".mkd")
}

/// 递归遍历目录生成文件树
/// show_hidden: 是否显示全部（含 NOISE_NAMES 清单与 dotfile）；false 时按 spec 过滤噪音 + dotfile
fn build_tree_inner(dir: &Path, show_hidden: bool) -> std::io::Result<Vec<TreeNode>> {
    let mut nodes: Vec<TreeNode> = Vec::new();
    let entries = fs::read_dir(dir)?;

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        // 默认（show_hidden=false）：
        //   - 跳过 spec 列出的噪音项（.git/.svn/.hg/.DS_Store/Thumbs.db/node_modules）
        //   - 跳过其他 dotfile（以 . 开头）
        if !show_hidden && (is_noise(&name) || name.starts_with('.')) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if metadata.is_dir() {
            let children = build_tree_inner(&path, show_hidden).unwrap_or_default();
            nodes.push(TreeNode {
                name,
                path: path.to_string_lossy().to_string(),
                node_type: "directory".to_string(),
                children: Some(children),
                size: None,
            });
        } else {
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
#[tauri::command]
pub fn list_tree(path: String, show_hidden: Option<bool>) -> Result<Vec<TreeNode>, String> {
    let dir = Path::new(&path);
    if !dir.exists() {
        return Err(format!("路径不存在: {}", path));
    }
    if !dir.is_dir() {
        return Err(format!("不是目录: {}", path));
    }
    let tree = build_tree_inner(dir, show_hidden.unwrap_or(false))
        .map_err(|e| format!("读取目录失败: {}: {}", path, e))?;
    Ok(tree)
}

/// 创建文件（若已存在则报错）
#[tauri::command]
pub fn create_file(path: String) -> Result<TreeNode, String> {
    let p = PathBuf::from(&path);
    if p.exists() {
        return Err(format!("文件已存在: {}", path));
    }
    // 确保父目录存在
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::File::create(&p).map_err(|e| e.to_string())?;
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
pub fn create_directory(path: String) -> Result<TreeNode, String> {
    let p = PathBuf::from(&path);
    if p.exists() {
        return Err(format!("目录已存在: {}", path));
    }
    fs::create_dir_all(&p).map_err(|e| e.to_string())?;
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
pub fn delete_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("路径不存在: {}", path));
    }
    trash::delete(&p).map_err(|e| e.to_string())
}

/// 重命名/移动文件或目录
#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<TreeNode, String> {
    let src = PathBuf::from(&from);
    let dst = PathBuf::from(&to);
    if !src.exists() {
        return Err(format!("源路径不存在: {}", from));
    }
    if dst.exists() {
        return Err(format!("目标已存在: {}", to));
    }
    // 确保目标父目录存在
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    let name = dst
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let node_type = if dst.is_dir() {
        "directory"
    } else {
        "file"
    };
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
pub fn copy_file(from: String, to: String) -> Result<TreeNode, String> {
    let src = PathBuf::from(&from);
    let dst = PathBuf::from(&to);
    if !src.exists() {
        return Err(format!("源文件不存在: {}", from));
    }
    if dst.exists() {
        return Err(format!("目标已存在: {}", to));
    }
    if src.is_dir() {
        return Err("copy_file 仅支持文件，不支持目录".to_string());
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::copy(&src, &dst).map_err(|e| e.to_string())?;
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
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// 读取文件内容（二进制，返回字节数组）
/// 用于 HTML 导出时将图片转为 Base64
#[tauri::command]
pub fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| e.to_string())
}

/// 写入文件内容（文本）
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// 检查路径是否存在
#[tauri::command]
pub fn path_exists(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).exists())
}

/// 获取路径类型："file" | "directory" | "none"
#[tauri::command]
pub fn path_type(path: String) -> Result<String, String> {
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
pub fn get_file_size(path: String) -> Result<u64, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    let metadata = fs::metadata(p).map_err(|e| e.to_string())?;
    Ok(metadata.len())
}

/// 在系统资源管理器中显示文件（Windows: explorer.exe /select,）
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("路径不存在: {}", path));
    }
    #[cfg(target_os = "windows")]
    {
        // 使用 explorer.exe /select,"path"
        std::process::Command::new("explorer.exe")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        // Linux: 打开父目录
        let parent = p.parent().unwrap_or(Path::new("."));
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 用系统默认程序打开文件或目录（应用打不开的文件的兜底出口，issue #307）
///
/// 不走 `plugin-shell` 的 `open`：能力集里的 `shell:default` 只放行 URL
/// （http(s) / `tel:` / `mailto:`），要打开本地路径得把 `allow-open` 的 scope 放宽到 `**`，
/// 为一个兜底入口扩大攻击面不划算。这里与 `reveal_in_explorer` 同形，用系统命令。
#[tauri::command]
pub fn open_with_default_app(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("路径不存在: {}", path));
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
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 只测错误分支：成功分支会真的拉起系统程序，不适合放进测试
    #[test]
    fn open_with_default_app_rejects_missing_path() {
        let missing = if cfg!(windows) {
            "Z:\\definitely\\not\\here\\murasaki-307.txt"
        } else {
            "/definitely/not/here/murasaki-307.txt"
        };
        let err = open_with_default_app(missing.to_string()).unwrap_err();
        assert!(err.contains("路径不存在"), "unexpected error: {err}");
    }

    #[test]
    fn get_file_size_returns_bytes() {
        let dir = std::env::temp_dir().join("murasaki-308-get-file-size");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Makefile");
        let content = "all:\n\techo hi\n";
        fs::write(&file, content).unwrap();

        let size = get_file_size(file.to_string_lossy().to_string()).unwrap();
        assert_eq!(size, content.len() as u64);

        let _ = fs::remove_file(&file);
        let _ = fs::remove_dir(&dir);
    }

    #[test]
    fn get_file_size_rejects_missing_path() {
        let missing = if cfg!(windows) {
            "Z:\\definitely\\not\\here\\murasaki-308"
        } else {
            "/definitely/not/here/murasaki-308"
        };
        let err = get_file_size(missing.to_string()).unwrap_err();
        assert!(err.contains("文件不存在"), "unexpected error: {err}");
    }

    #[test]
    fn build_tree_inner_returns_err_when_dir_unreadable() {
        let file = std::env::temp_dir().join("murasaki-408-not-a-dir");
        let _ = fs::remove_file(&file);
        fs::write(&file, b"x").unwrap();
        let result = build_tree_inner(&file, false);
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

        let hidden = build_tree_inner(&dir, true).unwrap();
        assert_eq!(hidden.len(), 2);

        let visible = build_tree_inner(&dir, false).unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].name, "a.md");

        let _ = fs::remove_dir_all(&dir);
    }
}
