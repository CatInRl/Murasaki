use std::fs;
use std::path::{Path, PathBuf};
use sha1::{Digest, Sha1};
use serde::{Deserialize, Serialize};

/// 草稿元数据（与前端 DraftMeta 对齐）
/// 用于 tabs.json 中记录每个 tab 的草稿状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftMeta {
    /// 原文件路径（绝对路径）
    pub path: String,
    /// 草稿文件的绝对路径
    pub draft_path: String,
    /// 上次已知 mtime（毫秒级 Unix 时间戳），用于启动时冲突检测
    pub known_mtime: u128,
    /// 草稿保存时间（毫秒级 Unix 时间戳）
    pub saved_at: u128,
}

/// 获取 Murasaki app data 目录：%APPDATA%\murasaki\
/// 若不存在则创建。
fn app_data_dir() -> Result<PathBuf, String> {
    // 优先使用 APPDATA 环境变量（Windows 标准）
    // 注意：开发环境启动脚本可能重定向 APPDATA 到工作区 .appdata/
    let base = dirs::data_dir()
        .or_else(|| std::env::var_os("APPDATA").map(PathBuf::from))
        .ok_or_else(|| "无法确定 app data 目录".to_string())?;
    let dir = base.join("murasaki");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

/// 草稿目录：%APPDATA%\murasaki\drafts\
fn drafts_dir() -> Result<PathBuf, String> {
    let dir = app_data_dir()?.join("drafts");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

/// 根据原文件路径计算草稿文件路径：drafts/<sha1(path)>
/// SHA1 避免路径中的特殊字符问题，且固定长度
fn draft_path_for(original_path: &str) -> Result<PathBuf, String> {
    let mut hasher = Sha1::new();
    hasher.update(original_path.as_bytes());
    // 转为十六进制字符串（40 字符）
    let hash = hasher.finalize();
    let hash_str: String = hash.iter().map(|b| format!("{:02x}", b)).collect();
    Ok(drafts_dir()?.join(hash_str))
}

/// 草稿 sidecar 元数据文件路径：drafts/<sha1(path)>.meta.json
/// 用于持久化 known_mtime（保存草稿时文件的 mtime），启动恢复时检测外部修改
fn draft_meta_path_for(original_path: &str) -> Result<PathBuf, String> {
    let draft_path = draft_path_for(original_path)?;
    Ok(PathBuf::from(format!("{}.meta.json", draft_path.to_string_lossy())))
}

/// 草稿 sidecar 元数据（仅持久化 known_mtime，其他字段运行时计算）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftMetaFile {
    known_mtime: u128,
}

/// 保存草稿：将内容写入草稿文件，返回草稿元数据
/// path: 原文件绝对路径
/// content: 草稿内容
/// known_mtime: 上次已知 mtime（毫秒），用于启动时冲突检测
#[tauri::command]
pub fn save_draft(
    path: String,
    content: String,
    known_mtime: u128,
) -> Result<DraftMeta, String> {
    let draft_path = draft_path_for(&path)?;
    // 确保草稿目录存在
    if let Some(parent) = draft_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&draft_path, content).map_err(|e| e.to_string())?;
    // 写 sidecar 元数据（known_mtime）以支持启动恢复时的冲突检测
    let meta = DraftMetaFile { known_mtime };
    let meta_path = draft_meta_path_for(&path)?;
    let meta_json = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
    fs::write(&meta_path, meta_json).map_err(|e| e.to_string())?;
    let saved_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    Ok(DraftMeta {
        path,
        draft_path: draft_path.to_string_lossy().to_string(),
        known_mtime,
        saved_at,
    })
}

/// 读取草稿内容
/// path: 原文件绝对路径
/// 返回 (content, draft_meta)
#[tauri::command]
pub fn read_draft(path: String) -> Result<(String, DraftMeta), String> {
    let draft_path = draft_path_for(&path)?;
    if !draft_path.exists() {
        return Err(format!("草稿不存在: {}", path));
    }
    let content = fs::read_to_string(&draft_path).map_err(|e| e.to_string())?;
    // 读取草稿文件的 mtime 作为 saved_at
    let metadata = fs::metadata(&draft_path).map_err(|e| e.to_string())?;
    let saved_at = metadata
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    // 从 sidecar 元数据文件读取 known_mtime
    let meta_path = draft_meta_path_for(&path)?;
    let known_mtime = if meta_path.exists() {
        fs::read_to_string(&meta_path)
            .ok()
            .and_then(|s| serde_json::from_str::<DraftMetaFile>(&s).ok())
            .map(|m| m.known_mtime)
            .unwrap_or(0)
    } else {
        0
    };
    Ok((
        content,
        DraftMeta {
            path,
            draft_path: draft_path.to_string_lossy().to_string(),
            known_mtime,
            saved_at,
        },
    ))
}

/// 删除草稿（文件保存后调用）
#[tauri::command]
pub fn delete_draft(path: String) -> Result<(), String> {
    let draft_path = draft_path_for(&path)?;
    if draft_path.exists() {
        fs::remove_file(&draft_path).map_err(|e| e.to_string())?;
    }
    // 同时删除 sidecar 元数据
    let meta_path = draft_meta_path_for(&path)?;
    if meta_path.exists() {
        fs::remove_file(&meta_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 检查草稿是否存在
#[tauri::command]
pub fn draft_exists(path: String) -> Result<bool, String> {
    let draft_path = draft_path_for(&path)?;
    Ok(draft_path.exists())
}

/// 获取 app data 目录路径（前端可用于读取 settings.json 等）
#[tauri::command]
pub fn get_app_data_dir() -> Result<String, String> {
    let dir = app_data_dir()?;
    Ok(dir.to_string_lossy().to_string())
}

/// 获取文件的当前 mtime（毫秒级 Unix 时间戳）
/// 若文件不存在返回错误
#[tauri::command]
pub fn get_file_mtime(path: String) -> Result<u128, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    let metadata = fs::metadata(p).map_err(|e| e.to_string())?;
    let mtime = metadata
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    Ok(mtime)
}
