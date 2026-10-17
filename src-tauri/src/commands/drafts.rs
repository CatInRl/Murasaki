use std::fs;
use std::path::{Path, PathBuf};
use super::atomic_write::write_atomic;
use super::sha1_hex;
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
    pub known_mtime: u64,
    /// 草稿保存时间（毫秒级 Unix 时间戳）
    pub saved_at: u64,
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
    // 转为十六进制字符串（40 字符）
    let hash_str = sha1_hex(original_path.as_bytes());
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
    known_mtime: u64,
}

/// 新草稿格式的首行标记：正文与 known_mtime 写在同一个文件里，
/// 保证两者要么一起更新、要么都不更新（旧格式为「正文 + sidecar」两文件）。
const DRAFT_MAGIC: &str = "MURASAKI-DRAFT-1";

/// 编码为单文件草稿：`<magic>\n<known_mtime>\n<正文>`
fn encode_draft(known_mtime: u64, content: &str) -> String {
    format!("{}\n{}\n{}", DRAFT_MAGIC, known_mtime, content)
}

/// 解析单文件草稿；不是新格式时返回 None（由调用方回退到旧格式读取）
fn decode_draft(raw: &str) -> Option<(u64, String)> {
    let mut parts = raw.splitn(3, '\n');
    if parts.next()? != DRAFT_MAGIC {
        return None;
    }
    let known_mtime = parts.next()?.parse::<u64>().ok()?;
    let content = parts.next()?.to_string();
    Some((known_mtime, content))
}

/// 保存草稿：将内容写入草稿文件，返回草稿元数据
/// path: 原文件绝对路径
/// content: 草稿内容
/// known_mtime: 上次已知 mtime（毫秒），用于启动时冲突检测
#[tauri::command]
pub fn save_draft(
    path: String,
    content: String,
    known_mtime: u64,
) -> Result<DraftMeta, String> {
    let draft_path = draft_path_for(&path)?;
    // 正文与 known_mtime 写在同一个文件里，一次原子替换完成
    let payload = encode_draft(known_mtime, &content);
    write_atomic(&draft_path, payload.as_bytes()).map_err(|e| e.to_string())?;
    // 旧格式遗留的 sidecar 不再需要；删除失败不影响草稿本身
    let meta_path = draft_meta_path_for(&path)?;
    if meta_path.exists() {
        let _ = fs::remove_file(&meta_path);
    }
    let saved_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
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
    let raw = fs::read_to_string(&draft_path).map_err(|e| e.to_string())?;
    // 读取草稿文件的 mtime 作为 saved_at
    let metadata = fs::metadata(&draft_path).map_err(|e| e.to_string())?;
    let saved_at = metadata
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    // 新格式自带 known_mtime；旧格式回退到 sidecar，再没有就按 0 处理
    let (known_mtime, content) = match decode_draft(&raw) {
        Some(decoded) => decoded,
        None => (read_legacy_known_mtime(&path), raw),
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

/// 读取旧格式草稿的 sidecar known_mtime；缺失时返回 0
fn read_legacy_known_mtime(original_path: &str) -> u64 {
    let meta_path = match draft_meta_path_for(original_path) {
        Ok(path) => path,
        Err(_) => return 0,
    };
    fs::read_to_string(&meta_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<DraftMetaFile>(&raw).ok())
        .map(|meta| meta.known_mtime)
        .unwrap_or(0)
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
pub fn get_file_mtime(path: String) -> Result<u64, String> {
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
        .as_millis() as u64;
    Ok(mtime)
}

#[cfg(test)]
mod tests {
    use super::{decode_draft, encode_draft, DRAFT_MAGIC};

    #[test]
    fn envelope_round_trips_multiline_content() {
        let content = "# 标题\n\n正文\n最后一行";
        let encoded = encode_draft(12345, content);
        assert_eq!(decode_draft(&encoded), Some((12345, content.to_string())));
    }

    #[test]
    fn envelope_round_trips_empty_content() {
        let encoded = encode_draft(0, "");
        assert_eq!(decode_draft(&encoded), Some((0, String::new())));
    }

    #[test]
    fn legacy_plain_text_is_rejected() {
        assert_eq!(decode_draft("plain content"), None);
        assert_eq!(decode_draft(""), None);
        assert_eq!(decode_draft("MURASAKI-DRAFT-1\nnot-a-number\nx"), None);
    }

    #[test]
    fn magic_value_is_stable() {
        // 格式一旦变更，旧草稿将无法识别；用常量固定住
        assert_eq!(DRAFT_MAGIC, "MURASAKI-DRAFT-1");
    }
}
