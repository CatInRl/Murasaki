/**
 * Agent 对话持久化 (Ticket #25)
 *
 * 设计：
 * - 每个工作区一个对话文件：chats/{sha1(workspacePath)}.json.gz
 * - chats/index.json 维护 hash → { workspacePath, lastUsedAt, messageCount } 映射
 * - gzip 压缩 + Rust 侧处理（前端不直接操作文件）
 * - 500ms debounce 由前端处理，Rust 侧每次 save 都是原子写入
 *
 * 安全性：
 * - workspacePath 必须为绝对路径（前端传入）
 * - 文件名仅使用 SHA1 hex（40 字符），无路径穿越风险
 *
 * 孤儿清理：
 * - 启动时扫描 index.json，检查 workspacePath 是否仍存在
 * - 不存在的标记为孤儿，前端可提示用户手动清理
 */
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use sha1::{Digest, Sha1};
use serde::{Deserialize, Serialize};
use flate2::write::GzEncoder;
use flate2::read::GzDecoder;
use flate2::Compression;

/// 获取 Murasaki app data 目录：%APPDATA%\murasaki\
/// 复用 drafts.rs 的逻辑（避免循环依赖，独立实现）
/// 优先使用 APPDATA 环境变量（支持开发环境重定向 + 单元测试覆盖）
fn app_data_dir() -> Result<PathBuf, String> {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| dirs::data_dir())
        .ok_or_else(|| "无法确定 app data 目录".to_string())?;
    let dir = base.join("murasaki");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

/// 对话目录：%APPDATA%\murasaki\chats\
fn chats_dir() -> Result<PathBuf, String> {
    let dir = app_data_dir()?.join("chats");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

/// 计算工作区路径的 SHA1 哈希（40 字符 hex）
fn hash_workspace_path(workspace: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(workspace.as_bytes());
    let hash = hasher.finalize();
    hash.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 对话文件路径：chats/{sha1(workspace)}.json.gz
fn chat_file_path(workspace: &str) -> Result<PathBuf, String> {
    let hash = hash_workspace_path(workspace);
    Ok(chats_dir()?.join(format!("{}.json.gz", hash)))
}

/// 索引文件路径：chats/index.json
fn index_file_path() -> Result<PathBuf, String> {
    Ok(chats_dir()?.join("index.json"))
}

/// 索引条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatIndexEntry {
    /// SHA1 哈希（文件名，不含扩展名）
    pub hash: String,
    /// 工作区绝对路径
    pub workspace_path: String,
    /// 最后使用时间（毫秒级 Unix 时间戳）
    pub last_used_at: u128,
    /// 消息数量
    pub message_count: u32,
}

/// 索引文件结构
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ChatIndex {
    entries: Vec<ChatIndexEntry>,
}

/// 读取索引文件（不存在则返回空索引）
fn read_index() -> Result<ChatIndex, String> {
    let path = index_file_path()?;
    if !path.exists() {
        return Ok(ChatIndex::default());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

/// 写入索引文件（原子写入：先写临时文件再 rename）
fn write_index(index: &ChatIndex) -> Result<(), String> {
    let path = index_file_path()?;
    let content = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, &content).map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// 更新索引条目（存在则更新，不存在则添加）
fn upsert_index_entry(workspace: &str, message_count: u32) -> Result<(), String> {
    let mut index = read_index()?;
    let hash = hash_workspace_path(workspace);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    if let Some(entry) = index.entries.iter_mut().find(|e| e.hash == hash) {
        entry.workspace_path = workspace.to_string();
        entry.last_used_at = now;
        entry.message_count = message_count;
    } else {
        index.entries.push(ChatIndexEntry {
            hash,
            workspace_path: workspace.to_string(),
            last_used_at: now,
            message_count,
        });
    }

    write_index(&index)
}

/// 从索引中删除条目
fn remove_index_entry(workspace: &str) -> Result<(), String> {
    let mut index = read_index()?;
    let hash = hash_workspace_path(workspace);
    index.entries.retain(|e| e.hash != hash);
    write_index(&index)
}

/// save_chat 返回值
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveChatResult {
    pub hash: String,
    pub message_count: u32,
    pub file_size: u64,
}

/**
 * 保存对话（gzip 压缩）
 *
 * 参数：
 * - workspace: 工作区根目录绝对路径
 * - messages_json: 序列化后的 ChatMessage[] JSON 字符串
 *
 * 返回：保存结果（hash、消息数、文件大小）
 */
#[tauri::command]
pub fn save_chat(workspace: String, messages_json: String) -> Result<SaveChatResult, String> {
    let chat_path = chat_file_path(&workspace)?;
    let hash = hash_workspace_path(&workspace);

    // 解析 JSON 以获取消息数量（同时验证格式）
    let messages: serde_json::Value =
        serde_json::from_str(&messages_json).map_err(|e| format!("invalid messages JSON: {}", e))?;
    let message_count = messages
        .as_array()
        .map(|arr| arr.len() as u32)
        .unwrap_or(0);

    // gzip 压缩
    let compressed = {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder
            .write_all(messages_json.as_bytes())
            .map_err(|e| format!("gzip encode failed: {}", e))?;
        encoder
            .finish()
            .map_err(|e| format!("gzip finish failed: {}", e))?
    };

    // 原子写入：先写临时文件再 rename
    let tmp_path = chat_path.with_extension("json.gz.tmp");
    fs::write(&tmp_path, &compressed).map_err(|e| format!("write chat file failed: {}", e))?;
    fs::rename(&tmp_path, &chat_path).map_err(|e| format!("rename chat file failed: {}", e))?;

    let file_size = compressed.len() as u64;

    // 更新索引
    upsert_index_entry(&workspace, message_count)?;

    Ok(SaveChatResult {
        hash,
        message_count,
        file_size,
    })
}

/// load_chat 返回值
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadChatResult {
    /// 反序列化后的 ChatMessage[] JSON 字符串
    pub messages_json: String,
    pub message_count: u32,
}

/**
 * 加载对话（gunzip 解压）
 *
 * 参数：
 * - workspace: 工作区根目录绝对路径
 *
 * 返回：LoadChatResult（含 messages_json）
 * 若对话文件不存在，返回空数组
 */
#[tauri::command]
pub fn load_chat(workspace: String) -> Result<LoadChatResult, String> {
    let chat_path = chat_file_path(&workspace)?;

    if !chat_path.exists() {
        return Ok(LoadChatResult {
            messages_json: "[]".to_string(),
            message_count: 0,
        });
    }

    // 读取 + gunzip 解压
    let compressed = fs::read(&chat_path).map_err(|e| format!("read chat file failed: {}", e))?;
    let mut decoder = GzDecoder::new(&compressed[..]);
    let mut messages_json = String::new();
    decoder
        .read_to_string(&mut messages_json)
        .map_err(|e| format!("gzip decode failed: {}", e))?;

    // 验证 JSON 格式 + 计算消息数
    let messages: serde_json::Value =
        serde_json::from_str(&messages_json).map_err(|e| format!("invalid messages JSON: {}", e))?;
    let message_count = messages
        .as_array()
        .map(|arr| arr.len() as u32)
        .unwrap_or(0);

    Ok(LoadChatResult {
        messages_json,
        message_count,
    })
}

/**
 * 删除对话文件 + 移除索引条目
 *
 * 用于"清空对话"操作。
 * 若文件不存在，视为成功（幂等）。
 */
#[tauri::command]
pub fn delete_chat(workspace: String) -> Result<bool, String> {
    let chat_path = chat_file_path(&workspace)?;

    // 删除对话文件（不存在则跳过）
    if chat_path.exists() {
        fs::remove_file(&chat_path).map_err(|e| format!("delete chat file failed: {}", e))?;
    }

    // 从索引中移除
    remove_index_entry(&workspace)?;

    Ok(true)
}

/**
 * 列出所有对话索引条目
 *
 * 用于孤儿检测和状态栏提示。
 */
#[tauri::command]
pub fn list_chats() -> Result<Vec<ChatIndexEntry>, String> {
    let index = read_index()?;
    Ok(index.entries)
}

/// Orphan 检测结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanCheckResult {
    /// 孤儿对话数量（workspacePath 不存在或为空）
    pub orphan_count: u32,
    /// 孤儿条目列表
    pub orphans: Vec<ChatIndexEntry>,
}

/**
 * 检测孤儿对话（workspacePath 不存在的对话）
 *
 * 用于启动时状态栏提示"N 个孤儿对话可清理"。
 */
#[tauri::command]
pub fn check_orphan_chats() -> Result<OrphanCheckResult, String> {
    let index = read_index()?;
    let orphans: Vec<ChatIndexEntry> = index
        .entries
        .into_iter()
        .filter(|e| {
            // workspacePath 为空或路径不存在 → 孤儿
            e.workspace_path.is_empty() || !std::path::Path::new(&e.workspace_path).exists()
        })
        .collect();

    Ok(OrphanCheckResult {
        orphan_count: orphans.len() as u32,
        orphans,
    })
}

/**
 * 清理孤儿对话（删除 workspacePath 不存在的对话文件 + 索引条目）
 *
 * 返回：清理的对话数量
 */
#[tauri::command]
pub fn cleanup_orphan_chats() -> Result<u32, String> {
    let index = read_index()?;
    let mut cleaned: u32 = 0;
    let mut survivors: Vec<ChatIndexEntry> = Vec::new();

    for entry in index.entries {
        let is_orphan = entry.workspace_path.is_empty()
            || !std::path::Path::new(&entry.workspace_path).exists();

        if is_orphan {
            // 删除对话文件
            let chat_path = chats_dir()?.join(format!("{}.json.gz", entry.hash));
            if chat_path.exists() {
                let _ = fs::remove_file(&chat_path);
            }
            cleaned += 1;
        } else {
            survivors.push(entry);
        }
    }

    // 写回索引（仅保留存活的条目）
    let new_index = ChatIndex {
        entries: survivors,
    };
    write_index(&new_index)?;

    Ok(cleaned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use std::sync::Mutex;

    /// 串行化测试锁：APPDATA 是进程级环境变量，并行测试会相互覆盖
    static TEST_MUTEX: Mutex<()> = Mutex::new(());

    /// 测试用的临时 app data 目录
    /// 通过设置 APPDATA 环境变量重定向
    struct TempAppData {
        _tmp: TempDir,
        old_appdata: Option<std::ffi::OsString>,
    }

    impl TempAppData {
        fn new() -> Self {
            let tmp = TempDir::new().expect("create tempdir");
            let old_appdata = std::env::var_os("APPDATA");
            // 设置 APPDATA 指向临时目录
            // 注意：app_data_dir() 优先使用 dirs::data_dir()，但在 Windows 上
            // dirs::data_dir() 通常返回 %APPDATA%\Roaming，所以设置 APPDATA 即可
            std::env::set_var("APPDATA", tmp.path());
            Self {
                _tmp: tmp,
                old_appdata,
            }
        }
    }

    impl Drop for TempAppData {
        fn drop(&mut self) {
            if let Some(old) = &self.old_appdata {
                std::env::set_var("APPDATA", old);
            } else {
                std::env::remove_var("APPDATA");
            }
        }
    }

    /// 测试环境：持有 mutex guard + TempAppData
    /// _guard 必须在 _temp 之前声明，确保释放顺序正确（先 temp 后 guard）
    struct TestEnv {
        _guard: std::sync::MutexGuard<'static, ()>,
        _temp: TempAppData,
    }

    impl TestEnv {
        fn new() -> Self {
            Self {
                // 恢复中毒的 mutex（前一个测试 panic 时可能中毒）
                _guard: TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner()),
                _temp: TempAppData::new(),
            }
        }
    }

    #[test]
    fn test_hash_workspace_path_stable() {
        let hash1 = hash_workspace_path("C:/workspace/markdown");
        let hash2 = hash_workspace_path("C:/workspace/markdown");
        assert_eq!(hash1, hash2);
        assert_eq!(hash1.len(), 40); // SHA1 hex = 40 chars
    }

    #[test]
    fn test_hash_workspace_path_different() {
        let hash1 = hash_workspace_path("C:/workspace/markdown");
        let hash2 = hash_workspace_path("C:/workspace/other");
        assert_ne!(hash1, hash2);
    }

    #[test]
    fn test_save_and_load_chat() {
        let _env = TestEnv::new();

        let workspace = "C:/test-workspace";
        let messages = r#"[{"id":"1","role":"user","content":"Hello","createdAt":1000}]"#;

        // 保存
        let save_result = save_chat(workspace.to_string(), messages.to_string()).unwrap();
        assert_eq!(save_result.message_count, 1);
        assert!(save_result.file_size > 0);

        // 加载
        let load_result = load_chat(workspace.to_string()).unwrap();
        assert_eq!(load_result.message_count, 1);
        assert_eq!(load_result.messages_json, messages);
    }

    #[test]
    fn test_load_nonexistent_chat_returns_empty() {
        let _env = TestEnv::new();

        let result = load_chat("C:/nonexistent-workspace".to_string()).unwrap();
        assert_eq!(result.message_count, 0);
        assert_eq!(result.messages_json, "[]");
    }

    #[test]
    fn test_delete_chat() {
        let _env = TestEnv::new();

        let workspace = "C:/delete-test";
        let messages = r#"[{"id":"1","role":"user","content":"Hi","createdAt":1000}]"#;

        // 保存
        save_chat(workspace.to_string(), messages.to_string()).unwrap();

        // 确认存在
        let loaded = load_chat(workspace.to_string()).unwrap();
        assert_eq!(loaded.message_count, 1);

        // 删除
        delete_chat(workspace.to_string()).unwrap();

        // 确认已删除
        let loaded_after = load_chat(workspace.to_string()).unwrap();
        assert_eq!(loaded_after.message_count, 0);
    }

    #[test]
    fn test_delete_nonexistent_chat_is_idempotent() {
        let _env = TestEnv::new();

        // 删除不存在的对话不应报错
        let result = delete_chat("C:/never-existed".to_string());
        assert!(result.is_ok());
    }

    #[test]
    fn test_list_chats() {
        let _env = TestEnv::new();

        // 保存两个对话
        save_chat(
            "C:/workspace1".to_string(),
            r#"[{"id":"1","role":"user","content":"A","createdAt":1000}]"#.to_string(),
        )
        .unwrap();
        save_chat(
            "C:/workspace2".to_string(),
            r#"[{"id":"1","role":"user","content":"B","createdAt":1000}]"#.to_string(),
        )
        .unwrap();

        let entries = list_chats().unwrap();
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn test_check_orphan_chats() {
        let _env = TestEnv::new();

        // workspace1 不存在（孤儿），workspace2 存在（需要真实路径）
        save_chat(
            "C:/nonexistent-workspace-1".to_string(),
            r#"[]"#.to_string(),
        )
        .unwrap();

        // 使用当前测试目录作为存在的 workspace
        let real_workspace = std::env::current_dir().unwrap();
        let real_workspace_str = real_workspace.to_string_lossy().to_string();
        save_chat(real_workspace_str.clone(), r#"[]"#.to_string()).unwrap();

        let result = check_orphan_chats().unwrap();
        assert_eq!(result.orphan_count, 1);
        assert_eq!(result.orphans.len(), 1);
        assert_eq!(result.orphans[0].workspace_path, "C:/nonexistent-workspace-1");
    }

    #[test]
    fn test_cleanup_orphan_chats() {
        let _env = TestEnv::new();

        // 创建一个孤儿对话
        save_chat(
            "C:/nonexistent-cleanup-test".to_string(),
            r#"[]"#.to_string(),
        )
        .unwrap();

        // 创建一个非孤儿对话
        let real_workspace = std::env::current_dir().unwrap();
        let real_workspace_str = real_workspace.to_string_lossy().to_string();
        save_chat(real_workspace_str.clone(), r#"[]"#.to_string()).unwrap();

        // 清理前
        let before = list_chats().unwrap();
        assert_eq!(before.len(), 2);

        // 清理
        let cleaned = cleanup_orphan_chats().unwrap();
        assert_eq!(cleaned, 1);

        // 清理后
        let after = list_chats().unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].workspace_path, real_workspace_str);
    }

    #[test]
    fn test_save_chat_updates_index() {
        let _env = TestEnv::new();

        let workspace = "C:/index-test-workspace";
        save_chat(
            workspace.to_string(),
            r#"[{"id":"1","role":"user","content":"test","createdAt":1000}]"#.to_string(),
        )
        .unwrap();

        let entries = list_chats().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].workspace_path, workspace);
        assert_eq!(entries[0].message_count, 1);
        assert!(!entries[0].hash.is_empty());
    }

    #[test]
    fn test_save_chat_replaces_existing() {
        let _env = TestEnv::new();

        let workspace = "C:/replace-test";
        save_chat(
            workspace.to_string(),
            r#"[{"id":"1","role":"user","content":"first","createdAt":1000}]"#.to_string(),
        )
        .unwrap();

        save_chat(
            workspace.to_string(),
            r#"[{"id":"1","role":"user","content":"first","createdAt":1000},{"id":"2","role":"assistant","content":"reply","createdAt":2000}]"#.to_string(),
        )
        .unwrap();

        // 索引应只有 1 个条目（更新而非添加）
        let entries = list_chats().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].message_count, 2);

        // 加载应返回最新内容
        let loaded = load_chat(workspace.to_string()).unwrap();
        assert_eq!(loaded.message_count, 2);
    }

    #[test]
    fn test_invalid_json_rejected() {
        let _env = TestEnv::new();

        let result = save_chat("C:/invalid-test".to_string(), "not valid json".to_string());
        assert!(result.is_err());
    }
}
