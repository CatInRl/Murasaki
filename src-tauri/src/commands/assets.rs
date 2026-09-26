use std::fs;
use std::path::{Path, PathBuf};
use super::sha1_hex;
use serde::Serialize;

/// 图片保存结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveImageResult {
    /// 图片绝对路径
    pub absolute_path: String,
    /// 相对工作区根的路径（如 assets/20260726-153045-a1b2c3.png）
    pub relative_path: String,
    /// 图片文件名（如 20260726-153045-a1b2c3.png）
    pub filename: String,
}

/// 获取当前时间戳字符串：YYYYMMDD-HHmmss
fn timestamp_str() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // 简单实现：用 chrono-like 手动计算
    // 注意：这里使用系统时间转 UTC+8（北京时间）以匹配用户期望
    // 但为了避免引入 chrono 依赖，直接用 UTC 即可，反正仅用于文件名
    let secs = now;
    let days = secs / 86400;
    let remainder = secs % 86400;
    let hour = remainder / 3600;
    let minute = (remainder % 3600) / 60;
    let second = remainder % 60;

    // 从 1970-01-01 计算年月日
    let (year, month, day) = days_to_ymd(days as i64);

    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        year, month, day, hour, minute, second
    )
}

/// 将 Unix 天数转为 (年, 月, 日)（公历）
fn days_to_ymd(days: i64) -> (i64, u32, u32) {
    // 算法来源：Howard Hinnant 的 date 算法
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

/// 计算字节序列的 SHA1 前 6 位（6 个十六进制字符）
fn short_hash(bytes: &[u8]) -> String {
    let full = sha1_hex(bytes);
    full.chars().take(6).collect()
}

/// 规范化扩展名：去除前导点，转小写
fn normalize_ext(ext: &str) -> String {
    let e = ext.trim_start_matches('.').to_lowercase();
    e
}

/// 规范化图片存放目录（相对工作区根）：拒绝绝对路径、根前缀、`.` 与 `..`。
///
/// 空值/仅空白回退到 `assets`（保持历史行为）；逐段拼接后统一用 `/` 分隔，
/// 顺带把 `assets//images` 这类写法规整掉（issue #151）。
///
/// 注意：**不能**在判断前先 trim 掉前导分隔符 —— 那样 Windows 的 `/abs` 与 Unix 的
/// `/abs` 都会被削成相对路径而放行，而 `PathBuf::join` 遇到带根前缀的路径会丢弃
/// 工作区前缀，直接落到盘根。
fn normalize_asset_dir(dir: Option<&str>) -> Result<String, String> {
    let raw = dir.unwrap_or("").trim();
    if raw.is_empty() {
        return Ok("assets".to_string());
    }
    let mut parts: Vec<String> = Vec::new();
    for comp in Path::new(raw).components() {
        match comp {
            std::path::Component::Normal(seg) => parts.push(seg.to_string_lossy().to_string()),
            _ => return Err(format!("图片目录必须是工作区内的相对路径: {}", raw)),
        }
    }
    if parts.is_empty() {
        return Ok("assets".to_string());
    }
    Ok(parts.join("/"))
}

/// 保存图片到工作区的指定子目录（默认 `assets/`）
/// - workspace: 工作区根路径
/// - bytes: 图片字节
/// - ext: 扩展名（如 "png" / ".jpg"）
/// - dir: 相对工作区根的子目录（如 "assets/images"），空则用 "assets"；必须是相对路径
/// - 返回相对路径如 assets/20260726-153045-a1b2c3.png
#[tauri::command]
pub fn save_image_asset(
    workspace: String,
    bytes: Vec<u8>,
    ext: String,
    dir: Option<String>,
) -> Result<SaveImageResult, String> {
    let ws = PathBuf::from(&workspace);
    if !ws.exists() {
        return Err(format!("工作区不存在: {}", workspace));
    }
    let rel_dir = normalize_asset_dir(dir.as_deref())?;
    let assets_dir = ws.join(&rel_dir);
    if !assets_dir.exists() {
        fs::create_dir_all(&assets_dir).map_err(|e| e.to_string())?;
    }

    let ext_norm = normalize_ext(&ext);
    let timestamp = timestamp_str();
    let hash = short_hash(&bytes);
    let filename = format!("{}-{}.{}", timestamp, hash, ext_norm);
    let abs_path = assets_dir.join(&filename);
    fs::write(&abs_path, &bytes).map_err(|e| e.to_string())?;

    let relative_path = format!("{}/{}", rel_dir, filename);
    Ok(SaveImageResult {
        absolute_path: abs_path.to_string_lossy().to_string(),
        relative_path,
        filename,
    })
}

/// 复制已有图片文件到工作区 assets/ 目录（用于从外部拖入图片文件）
/// - source_path: 源图片绝对路径
/// - workspace: 工作区根路径
#[tauri::command]
pub fn copy_image_to_assets(
    source_path: String,
    workspace: String,
) -> Result<SaveImageResult, String> {
    let src = Path::new(&source_path);
    if !src.exists() {
        return Err(format!("源文件不存在: {}", source_path));
    }
    let bytes = fs::read(src).map_err(|e| e.to_string())?;
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_string();
    save_image_asset(workspace, bytes, ext, None)
}

// ===== 单元测试 =====
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_short_hash_consistent() {
        let bytes = b"hello world";
        let h1 = short_hash(bytes);
        let h2 = short_hash(bytes);
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 6);
    }

    #[test]
    fn test_short_hash_differs() {
        let h1 = short_hash(b"hello");
        let h2 = short_hash(b"world");
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_normalize_ext() {
        assert_eq!(normalize_ext("PNG"), "png");
        assert_eq!(normalize_ext(".jpg"), "jpg");
        assert_eq!(normalize_ext("jpeg"), "jpeg");
        assert_eq!(normalize_ext(""), "");
    }

    #[test]
    fn test_save_image_asset_creates_assets_dir() {
        let dir = TempDir::new().unwrap();
        let ws = dir.path().to_string_lossy().to_string();
        let bytes = b"\x89PNG\r\n\x1a\nfakepngbytes";
        let result = save_image_asset(ws.clone(), bytes.to_vec(), "png".to_string(), None).unwrap();
        // assets 目录应自动创建
        assert!(dir.path().join("assets").exists());
        // 文件存在
        assert!(Path::new(&result.absolute_path).exists());
        // 相对路径格式正确
        assert!(result.relative_path.starts_with("assets/"));
        assert!(result.relative_path.ends_with(".png"));
        // 文件名包含时间戳与哈希
        assert!(result.filename.contains("-"));
        assert!(result.filename.ends_with(".png"));
    }

    #[test]
    fn test_save_image_asset_filename_format() {
        let dir = TempDir::new().unwrap();
        let ws = dir.path().to_string_lossy().to_string();
        let bytes = b"test";
        let result = save_image_asset(ws, bytes.to_vec(), "jpg".to_string(), None).unwrap();
        // 文件名格式：YYYYMMDD-HHmmss-<6hex>.jpg
        let parts: Vec<&str> = result.filename.split('-').collect();
        assert_eq!(parts.len(), 3);
        // 第一部分是 8 位日期
        assert_eq!(parts[0].len(), 8);
        // 第二部分是 6 位时间
        assert_eq!(parts[1].len(), 6);
        // 第三部分是 6 位哈希 + .jpg
        assert!(parts[2].ends_with(".jpg"));
        let hash_part = parts[2].split('.').next().unwrap();
        assert_eq!(hash_part.len(), 6);
    }

    #[test]
    fn test_copy_image_to_assets() {
        let dir = TempDir::new().unwrap();
        // 创建源图片
        let src_path = dir.path().join("source.png");
        fs::write(&src_path, b"\x89PNG\r\n\x1a\nfake").unwrap();
        // 创建独立工作区目录
        let ws_dir = dir.path().join("workspace");
        fs::create_dir(&ws_dir).unwrap();
        let ws = ws_dir.to_string_lossy().to_string();

        let result = copy_image_to_assets(
            src_path.to_string_lossy().to_string(),
            ws.clone(),
        )
        .unwrap();
        assert!(result.absolute_path.ends_with(".png"));
        assert!(Path::new(&result.absolute_path).exists());
        // 原文件仍存在（不删除源）
        assert!(src_path.exists());
    }

    #[test]
    fn test_save_image_asset_workspace_not_exist() {
        let result = save_image_asset(
            "/nonexistent/path/xyz".to_string(),
            vec![1, 2, 3],
            "png".to_string(),
            None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_normalize_asset_dir() {
        // 空值回退 assets
        assert_eq!(normalize_asset_dir(None).unwrap(), "assets");
        assert_eq!(normalize_asset_dir(Some("")).unwrap(), "assets");
        assert_eq!(normalize_asset_dir(Some("  ")).unwrap(), "assets");
        // 自定义目录：统一用 /，并规整重复分隔符
        assert_eq!(normalize_asset_dir(Some("assets/images")).unwrap(), "assets/images");
        assert_eq!(normalize_asset_dir(Some("assets//images")).unwrap(), "assets/images");
        #[cfg(windows)]
        assert_eq!(normalize_asset_dir(Some("assets\\images")).unwrap(), "assets/images");
        // 越权 / 不可用路径一律拒绝（含前导分隔符：join 出去会落到盘根）
        for bad in ["../outside", "assets/../outside", ".", "..", "/assets/images", "/"] {
            assert!(
                normalize_asset_dir(Some(bad)).is_err(),
                "应拒绝的目录被放行了: {}",
                bad
            );
        }
        #[cfg(windows)]
        for bad in ["\\assets", "C:\\abs\\dir"] {
            assert!(
                normalize_asset_dir(Some(bad)).is_err(),
                "应拒绝的目录被放行了: {}",
                bad
            );
        }
    }

    #[test]
    fn test_save_image_asset_custom_dir() {
        let dir = TempDir::new().unwrap();
        let ws = dir.path().to_string_lossy().to_string();
        let bytes = b"\x89PNG\r\n\x1a\nfakepngbytes";
        let result =
            save_image_asset(ws, bytes.to_vec(), "png".to_string(), Some("assets/images".into()))
                .unwrap();
        // 目录按设置创建
        assert!(dir.path().join("assets").join("images").exists());
        assert!(Path::new(&result.absolute_path).exists());
        // 相对路径带上自定义目录（issue #151）
        assert!(result.relative_path.starts_with("assets/images/"));
        assert!(result.relative_path.ends_with(".png"));
    }

    #[test]
    fn test_save_image_asset_rejects_escaping_dir() {
        let dir = TempDir::new().unwrap();
        let ws = dir.path().to_string_lossy().to_string();
        let result =
            save_image_asset(ws, vec![1, 2, 3], "png".to_string(), Some("../outside".into()));
        assert!(result.is_err());
    }

    #[test]
    fn test_days_to_ymd_known_dates() {
        // 1970-01-01 是 Unix 纪元，days=0
        let (y, m, d) = days_to_ymd(0);
        assert_eq!((y, m, d), (1970, 1, 1));
        // 2026-01-01 大约是 20454 天后
        let (y, m, d) = days_to_ymd(20454);
        assert_eq!((y, m, d), (2026, 1, 1));
    }
}
