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
        // 2. 字符类别分组
        let ca = category_of(&a.name);
        let cb = category_of(&b.name);
        if ca != cb {
            return ca.cmp(&cb);
        }
        // 3. 组内排序
        match ca {
            0 => natural_lexical_cmp(&a.name, &b.name),        // 数字自然序
            1 => a.name.to_lowercase().cmp(&b.name.to_lowercase()), // 英文字母序（大小写不敏感）
            2 => pinyin_cmp(&a.name, &b.name),                 // 中文拼音序
            _ => a.name.cmp(&b.name),                          // 其他 Unicode 码点序
        }
    });
}

/// 递归遍历目录生成文件树
/// show_hidden: 是否显示全部（含 NOISE_NAMES 清单与 dotfile）；false 时按 spec 过滤噪音 + dotfile
fn build_tree_inner(dir: &Path, show_hidden: bool) -> Vec<TreeNode> {
    let mut nodes: Vec<TreeNode> = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return nodes,
    };

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
            let children = build_tree_inner(&path, show_hidden);
            nodes.push(TreeNode {
                name,
                path: path.to_string_lossy().to_string(),
                node_type: "directory".to_string(),
                children: Some(children),
            });
        } else {
            nodes.push(TreeNode {
                name,
                path: path.to_string_lossy().to_string(),
                node_type: "file".to_string(),
                children: None,
            });
        }
    }

    sort_tree_nodes(&mut nodes);
    nodes
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
    Ok(build_tree_inner(dir, show_hidden.unwrap_or(false)))
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
    Ok(TreeNode {
        name,
        path: dst.to_string_lossy().to_string(),
        node_type: "file".to_string(),
        children: None,
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
