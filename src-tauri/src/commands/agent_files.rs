/**
 * Agent 文件类工具后端命令（Ticket #22）
 *
 * - agent_list_files: 列出工作区内 .md 文件（相对路径数组）
 * - agent_read_file:  读取文件内容（4K 截断）+ 元数据
 * - agent_search_files: 跨文件搜索（4K 截断）
 *
 * 所有命令在 Rust 侧 resolve 路径后检查是否在工作区根目录内，
 * 越界直接返回 Err("path outside workspace")，不读文件。
 *
 * 复用现有 search.rs 的搜索逻辑思路（避免循环依赖，独立实现简化版）。
 */
use std::fs;
use std::path::{Path, PathBuf};
use serde::Serialize;
use sha1::{Digest, Sha1};
use walkdir::WalkDir;

/// 读取文件最大字符数（4K 阈值）
const READ_FILE_MAX_CHARS: usize = 4096;

/// 搜索结果最大字符数（4K 阈值）
const SEARCH_MAX_CHARS: usize = 4096;

/// 判断是否为 Markdown 文件
fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_lowercase().as_str(), "md" | "markdown" | "mdown" | "mkd"))
        .unwrap_or(false)
}

/// 规范化路径：手动解析 `.` 和 `..`，不解析符号链接（文件可能不存在）
fn normalize_path(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                result.pop();
            }
            std::path::Component::CurDir => {}
            other => result.push(other),
        }
    }
    result
}

/**
 * 验证目标路径在工作区内
 *
 * 参数：
 * - workspace: 工作区根目录绝对路径
 * - target:    目标相对路径（如 "intro.md"、"sub/deep.md"）
 *
 * 返回：resolve 后的绝对路径，或 "path outside workspace" 错误
 *
 * 安全性：
 * - 拒绝绝对路径（target 必须为相对路径）
 * - 通过手动规范化解析 `..`，避免 canonicalize 在文件不存在时失败
 * - 规范化后必须以 workspace 为前缀
 */
fn ensure_within_workspace(workspace: &str, target: &str) -> Result<PathBuf, String> {
    let ws = PathBuf::from(workspace).canonicalize()
        .map_err(|e| format!("invalid workspace: {}", e))?;

    let target_path = Path::new(target);
    if target_path.is_absolute() {
        return Err("path outside workspace".to_string());
    }

    let joined = ws.join(target);
    let normalized = normalize_path(&joined);

    if !normalized.starts_with(&ws) {
        return Err("path outside workspace".to_string());
    }
    Ok(normalized)
}

/// agent_list_files 返回值：相对路径字符串数组
#[tauri::command]
pub fn agent_list_files(workspace: String) -> Result<Vec<String>, String> {
    let ws_path = PathBuf::from(&workspace);
    if !ws_path.exists() {
        return Err(format!("workspace not exists: {}", workspace));
    }

    let mut files: Vec<String> = Vec::new();
    // 使用 ws_path（非 canonicalize 后的）作为 strip_prefix 基准，
    // 因为 WalkDir 返回的 path 基于 ws_path，而非 canonicalize 后的 UNC 路径
    for entry in WalkDir::new(&ws_path)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() || !is_markdown(path) {
            continue;
        }
        // 过滤 assets/ 目录下的文件（图片资源，非 Markdown 内容）
        // 用字符串匹配避免 OsStr 跨平台比较问题
        let path_str = path.to_string_lossy().replace('\\', "/");
        if path_str.contains("/assets/") {
            continue;
        }
        // 转换为相对路径（forward slash 风格，跨平台一致）
        let rel = path.strip_prefix(&ws_path).unwrap_or(path);
        files.push(rel.to_string_lossy().replace('\\', "/"));
    }
    files.sort();
    Ok(files)
}

/// agent_read_file 返回值
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReadFileResult {
    /// 相对工作区的路径
    pub doc_path: String,
    /// 文件内容（4K 截断）
    pub content: String,
    /// 内容 SHA1 哈希（基于完整内容计算）
    pub content_hash: String,
    /// 完整内容字符数
    pub content_length: usize,
    /// 是否被截断
    pub truncated: bool,
}

/// 读取工作区内文件内容（4K 截断）+ 元数据
#[tauri::command]
pub fn agent_read_file(workspace: String, path: String) -> Result<AgentReadFileResult, String> {
    let target_path = ensure_within_workspace(&workspace, &path)?;
    if !target_path.exists() {
        return Err(format!("file not found: {}", path));
    }
    if !target_path.is_file() {
        return Err(format!("not a file: {}", path));
    }
    if !is_markdown(&target_path) {
        return Err("only markdown files are readable".to_string());
    }

    let content = fs::read_to_string(&target_path).map_err(|e| e.to_string())?;
    let content_length = content.chars().count();
    let truncated = content_length > READ_FILE_MAX_CHARS;
    let truncated_content = if truncated {
        let taken: String = content.chars().take(READ_FILE_MAX_CHARS).collect();
        taken + "\n... [truncated]"
    } else {
        content.clone()
    };

    let mut hasher = Sha1::new();
    hasher.update(content.as_bytes());
    let content_hash = format!("{:x}", hasher.finalize());

    Ok(AgentReadFileResult {
        doc_path: path.replace('\\', "/"),
        content: truncated_content,
        content_hash,
        content_length,
        truncated,
    })
}

/// agent_write_file 返回值
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWriteFileResult {
    /// 相对工作区的路径
    pub doc_path: String,
    /// 绝对路径
    pub absolute_path: String,
    /// 内容字符数
    pub content_length: usize,
}

/**
 * 在工作区内写入新文件（Ticket #24: propose_new_file 后端支持）
 *
 * 安全性：
 * - 路径必须为相对路径，resolve 后必须在工作区内
 * - 若文件已存在，返回 "file exists" 错误（由前端弹冲突对话框）
 * - 自动创建父目录
 * - 仅允许 .md/.markdown/.mdown/.mkd 扩展名
 *
 * 参数：
 * - workspace: 工作区根目录绝对路径
 * - path:      目标相对路径（如 "new-note.md" 或 "sub/notes.md"）
 * - content:   文件内容
 */
#[tauri::command]
pub fn agent_write_file(
    workspace: String,
    path: String,
    content: String,
) -> Result<AgentWriteFileResult, String> {
    let target_path = ensure_within_workspace(&workspace, &path)?;

    // 拒绝已存在的文件（前端负责冲突解决）
    if target_path.exists() {
        return Err("file exists".to_string());
    }

    // 仅允许 Markdown 文件
    if !is_markdown(&target_path) {
        return Err("only markdown files are writable".to_string());
    }

    // 创建父目录（如 sub/ 不存在）
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create parent dir failed: {}", e))?;
    }

    fs::write(&target_path, &content).map_err(|e| format!("write failed: {}", e))?;

    let content_length = content.chars().count();
    Ok(AgentWriteFileResult {
        doc_path: path.replace('\\', "/"),
        absolute_path: target_path.to_string_lossy().to_string(),
        content_length,
    })
}

/// agent_search_files 单个命中
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSearchHit {
    /// 相对工作区的文件路径
    pub file_path: String,
    /// 行号（1-indexed）
    pub line_number: u32,
    /// 命中行内容
    pub line_content: String,
    /// 前两行上下文
    pub context_before: Vec<String>,
    /// 后两行上下文
    pub context_after: Vec<String>,
}

/// agent_search_files 返回值
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSearchResult {
    /// 命中列表（按 4K 阈值截断）
    pub hits: Vec<AgentSearchHit>,
    /// 命中总数（截断前的实际数）
    pub total_hits: usize,
    /// 是否被截断
    pub truncated: bool,
}

/**
 * 跨文件搜索（agent 专用，4K 截断）
 *
 * 参数：
 * - workspace: 工作区根目录绝对路径
 * - query:     搜索关键词
 * - is_regex:  是否为正则模式（默认 false）
 *
 * 搜索范围：工作区内所有 .md 文件（排除 assets/ 目录）
 * 大小写：默认不敏感（与现有 search_workspace 行为一致）
 */
#[tauri::command]
pub fn agent_search_files(
    workspace: String,
    query: String,
    is_regex: Option<bool>,
) -> Result<AgentSearchResult, String> {
    if query.trim().is_empty() {
        return Ok(AgentSearchResult {
            hits: Vec::new(),
            total_hits: 0,
            truncated: false,
        });
    }

    let use_regex = is_regex.unwrap_or(false);
    let pattern = if use_regex {
        query.clone()
    } else {
        regex::escape(&query)
    };
    let re = regex::Regex::new(&format!("(?i){}", pattern))
        .map_err(|e| e.to_string())?;

    let ws_path = PathBuf::from(&workspace);
    if !ws_path.exists() {
        return Err(format!("workspace not exists: {}", workspace));
    }

    let mut hits: Vec<AgentSearchHit> = Vec::new();
    let mut total_hits: usize = 0;
    let mut total_chars: usize = 0;
    let mut truncated = false;

    'outer: for entry in WalkDir::new(&ws_path)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() || !is_markdown(path) {
            continue;
        }
        let path_str = path.to_string_lossy().replace('\\', "/");
        if path_str.contains("/assets/") {
            continue;
        }
        let rel = path.strip_prefix(&ws_path).unwrap_or(path);
        let rel_str = rel.to_string_lossy().replace('\\', "/");

        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let lines: Vec<&str> = content.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            if re.is_match(line) {
                total_hits += 1;
                let line_number = (i + 1) as u32;
                let before_start = i.saturating_sub(2);
                let context_before: Vec<String> = lines[before_start..i]
                    .iter()
                    .map(|s| s.to_string())
                    .collect();
                let after_end = (i + 3).min(lines.len());
                let context_after: Vec<String> = lines[(i + 1)..after_end]
                    .iter()
                    .map(|s| s.to_string())
                    .collect();

                // 估算大小：行内容 + 上下文 + 文件路径
                let est_size = line.len()
                    + context_before.iter().map(|s| s.len()).sum::<usize>()
                    + context_after.iter().map(|s| s.len()).sum::<usize>()
                    + rel_str.len();

                if total_chars + est_size > SEARCH_MAX_CHARS {
                    truncated = true;
                    break 'outer;
                }
                total_chars += est_size;

                hits.push(AgentSearchHit {
                    file_path: rel_str.clone(),
                    line_number,
                    line_content: line.to_string(),
                    context_before,
                    context_after,
                });
            }
        }
    }

    Ok(AgentSearchResult {
        hits,
        total_hits,
        truncated,
    })
}

// ===== 单元测试 =====
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn create_test_workspace() -> TempDir {
        let dir = TempDir::new().expect("创建临时目录失败");
        fs::write(
            dir.path().join("intro.md"),
            "# Introduction\n\nWelcome to Murasaki.\nIt is a markdown editor.\nFast and lightweight.\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("notes.md"),
            "# Notes\n\nMurasaki is lightweight.\nIt supports search.\n",
        )
        .unwrap();
        // 子目录
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(
            dir.path().join("sub").join("deep.md"),
            "# Deep Title\n\nMurasaki deep content here.\n",
        )
        .unwrap();
        // assets 目录（应被过滤）
        fs::create_dir(dir.path().join("assets")).unwrap();
        fs::write(dir.path().join("assets").join("image.md"), "should not appear\n").unwrap();
        // 非 markdown 文件（应被过滤）
        fs::write(dir.path().join("readme.txt"), "Murasaki txt\n").unwrap();
        dir
    }

    #[test]
    fn test_agent_list_files_returns_only_md() {
        let dir = create_test_workspace();
        let ws = dir.path().to_string_lossy().to_string();
        let files = agent_list_files(ws).unwrap();
        // intro.md, notes.md, sub/deep.md（assets/image.md 被过滤）
        assert_eq!(files.len(), 3);
        assert!(files.iter().any(|f| f == "intro.md"));
        assert!(files.iter().any(|f| f == "notes.md"));
        assert!(files.iter().any(|f| f == "sub/deep.md"));
        // 不应包含 assets 目录下的文件
        assert!(!files.iter().any(|f| f.contains("assets")));
        // 不应包含非 md 文件
        assert!(!files.iter().any(|f| f.contains("readme.txt")));
    }

    #[test]
    fn test_agent_list_files_uses_forward_slash() {
        let dir = create_test_workspace();
        let ws = dir.path().to_string_lossy().to_string();
        let files = agent_list_files(ws).unwrap();
        // 子目录路径应使用 forward slash（跨平台一致）
        assert!(files.iter().any(|f| f == "sub/deep.md"));
        // 不应包含 backslash
        assert!(!files.iter().any(|f| f.contains('\\')));
    }

    #[test]
    fn test_agent_read_file_returns_content_and_metadata() {
        let dir = create_test_workspace();
        let ws = dir.path().to_string_lossy().to_string();
        let result = agent_read_file(ws.clone(), "intro.md".to_string()).unwrap();
        assert_eq!(result.doc_path, "intro.md");
        assert!(result.content.contains("Welcome to Murasaki"));
        assert!(!result.truncated);
        assert_eq!(result.content_length, result.content.chars().count());
        // SHA1 哈希应为 40 位十六进制
        assert_eq!(result.content_hash.len(), 40);
        assert!(result.content_hash.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_agent_read_file_truncates_long_content() {
        let dir = TempDir::new().unwrap();
        let long_content = "x".repeat(10000);
        fs::write(dir.path().join("long.md"), &long_content).unwrap();
        let ws = dir.path().to_string_lossy().to_string();
        let result = agent_read_file(ws, "long.md".to_string()).unwrap();
        assert!(result.truncated);
        assert_eq!(result.content_length, 10000);
        // 截断后内容应小于完整长度
        assert!(result.content.chars().count() < 10000);
        assert!(result.content.contains("[truncated]"));
    }

    #[test]
    fn test_agent_read_file_path_outside_workspace_rejected() {
        let dir = create_test_workspace();
        let ws = dir.path().to_string_lossy().to_string();
        // 尝试越界：通过 .. 跳出工作区
        let err = agent_read_file(ws.clone(), "../outside.md".to_string()).unwrap_err();
        assert_eq!(err, "path outside workspace");

        // 绝对路径也应被拒绝
        let abs_path = dir.path().join("intro.md").to_string_lossy().to_string();
        let err = agent_read_file(ws, abs_path).unwrap_err();
        assert_eq!(err, "path outside workspace");
    }

    #[test]
    fn test_agent_read_file_nonexistent_returns_not_found() {
        let dir = create_test_workspace();
        let ws = dir.path().to_string_lossy().to_string();
        // 越界检查通过后，文件不存在应返回 file not found
        let err = agent_read_file(ws, "nonexistent.md".to_string()).unwrap_err();
        assert!(err.contains("file not found"));
    }

    #[test]
    fn test_agent_read_file_non_markdown_rejected() {
        let dir = create_test_workspace();
        let ws = dir.path().to_string_lossy().to_string();
        let err = agent_read_file(ws, "readme.txt".to_string()).unwrap_err();
        assert!(err.contains("only markdown"));
    }

    #[test]
    fn test_agent_search_files_basic_match() {
        let dir = create_test_workspace();
        let ws = dir.path().to_string_lossy().to_string();
        let result = agent_search_files(ws, "Murasaki".to_string(), None).unwrap();
        // 3 个 .md 文件都含 Murasaki
        assert!(result.total_hits >= 3);
        assert!(!result.truncated);
    }

    #[test]
    fn test_agent_search_files_case_insensitive_default() {
        let dir = create_test_workspace();
        let ws = dir.path().to_string_lossy().to_string();
        let result = agent_search_files(ws, "murasaki".to_string(), None).unwrap();
        // 默认大小写不敏感
        assert!(result.total_hits >= 3);
    }

    #[test]
    fn test_agent_search_files_regex_mode() {
        let dir = create_test_workspace();
        let ws = dir.path().to_string_lossy().to_string();
        // 使用 intro.md 同行内匹配的模式：行 3 "Welcome to Murasaki."
        let result = agent_search_files(ws, "Welcome.*saki".to_string(), Some(true)).unwrap();
        // 只有 intro.md 同行包含 Welcome + saki
        assert_eq!(result.total_hits, 1);
        assert!(result.hits[0].file_path == "intro.md");
    }

    #[test]
    fn test_agent_search_files_empty_query_returns_empty() {
        let dir = create_test_workspace();
        let ws = dir.path().to_string_lossy().to_string();
        let result = agent_search_files(ws, "".to_string(), None).unwrap();
        assert_eq!(result.total_hits, 0);
        assert!(result.hits.is_empty());
    }

    #[test]
    fn test_agent_search_files_truncates_at_4k() {
        let dir = TempDir::new().unwrap();
        // 写入多个长文件，确保命中数足够多触发截断
        for i in 0..50 {
            let content = format!("Line {} has keyword ABCDE\n", i);
            // 重复写入以累积大量命中
            let full_content = content.repeat(10);
            fs::write(dir.path().join(format!("file{}.md", i)), full_content).unwrap();
        }
        let ws = dir.path().to_string_lossy().to_string();
        let result = agent_search_files(ws, "keyword".to_string(), None).unwrap();
        assert!(result.truncated);
        // 命中数远大于 0
        assert!(result.hits.len() > 0);
        // 但总字符数应小于 4K + 单行最大长度
        let total_size: usize = result.hits.iter()
            .map(|h| h.line_content.len()
                + h.context_before.iter().map(|s| s.len()).sum::<usize>()
                + h.context_after.iter().map(|s| s.len()).sum::<usize>()
                + h.file_path.len())
            .sum::<usize>();
        assert!(total_size <= SEARCH_MAX_CHARS * 2); // 容差：单个命中估算上限
    }

    #[test]
    fn test_agent_search_files_excludes_assets_directory() {
        let dir = create_test_workspace();
        let ws = dir.path().to_string_lossy().to_string();
        // assets/image.md 包含 "should not appear"
        let result = agent_search_files(ws.clone(), "should not appear".to_string(), None).unwrap();
        assert_eq!(result.total_hits, 0);

        // 但其他文件中的 "Murasaki" 仍可命中
        let result2 = agent_search_files(ws, "Murasaki".to_string(), None).unwrap();
        assert!(result2.total_hits > 0);
        // 所有命中都不应在 assets/ 下
        for hit in &result2.hits {
            assert!(!hit.file_path.starts_with("assets/"));
        }
    }

    #[test]
    fn test_agent_search_files_returns_relative_paths() {
        let dir = create_test_workspace();
        let ws = dir.path().to_string_lossy().to_string();
        // 搜索 sub/deep.md 标题中独有的 "Deep Title"
        let result = agent_search_files(ws, "Deep Title".to_string(), None).unwrap();
        // 命中应在 sub/deep.md（相对路径 + forward slash）
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].file_path, "sub/deep.md");
    }

    #[test]
    fn test_agent_search_files_context_lines() {
        let dir = create_test_workspace();
        let ws = dir.path().to_string_lossy().to_string();
        let result = agent_search_files(ws, "Welcome".to_string(), None).unwrap();
        let hit = &result.hits[0];
        assert_eq!(hit.line_number, 3);
        // context_before: 前 2 行（# Introduction 和空行）
        assert_eq!(hit.context_before.len(), 2);
        assert_eq!(hit.context_before[0], "# Introduction");
        // context_after: 后 2 行
        assert_eq!(hit.context_after.len(), 2);
        assert_eq!(hit.context_after[0], "It is a markdown editor.");
    }

    #[test]
    fn test_ensure_within_workspace_rejects_absolute_path() {
        let dir = create_test_workspace();
        let ws = dir.path().to_string_lossy().to_string();
        let abs = dir.path().join("intro.md").to_string_lossy().to_string();
        let err = ensure_within_workspace(&ws, &abs).unwrap_err();
        assert_eq!(err, "path outside workspace");
    }

    #[test]
    fn test_ensure_within_workspace_rejects_dotdot_escape() {
        let dir = create_test_workspace();
        let ws = dir.path().to_string_lossy().to_string();
        let err = ensure_within_workspace(&ws, "../escape.md").unwrap_err();
        assert_eq!(err, "path outside workspace");

        // 多层 .. 也应被拒绝
        let err = ensure_within_workspace(&ws, "../../etc/passwd").unwrap_err();
        assert_eq!(err, "path outside workspace");
    }

    #[test]
    fn test_ensure_within_workspace_accepts_relative_path() {
        let dir = create_test_workspace();
        let ws = dir.path().to_string_lossy().to_string();
        let resolved = ensure_within_workspace(&ws, "intro.md").unwrap();
        assert!(resolved.ends_with("intro.md"));

        // 子目录相对路径
        let resolved = ensure_within_workspace(&ws, "sub/deep.md").unwrap();
        assert!(resolved.ends_with("deep.md"));
    }

    #[test]
    fn test_ensure_within_workspace_accepts_dot_path() {
        let dir = create_test_workspace();
        let ws = dir.path().to_string_lossy().to_string();
        // "./intro.md" 应等同于 "intro.md"
        let resolved = ensure_within_workspace(&ws, "./intro.md").unwrap();
        assert!(resolved.ends_with("intro.md"));
    }

    // ===== agent_write_file tests (Ticket #24) =====

    #[test]
    fn test_agent_write_file_creates_new_file() {
        let dir = create_test_workspace();
        let ws = dir.path().to_string_lossy().to_string();
        let result = agent_write_file(
            ws.clone(),
            "new-note.md".to_string(),
            "# New Note\n\nContent here.".to_string(),
        )
        .unwrap();
        assert_eq!(result.doc_path, "new-note.md");
        // 文件确实写入磁盘
        let written = fs::read_to_string(dir.path().join("new-note.md")).unwrap();
        assert!(written.contains("# New Note"));
        assert_eq!(result.content_length, "# New Note\n\nContent here.".chars().count());
    }

    #[test]
    fn test_agent_write_file_creates_parent_dirs() {
        let dir = TempDir::new().unwrap();
        let ws = dir.path().to_string_lossy().to_string();
        // 子目录不存在
        let result = agent_write_file(
            ws,
            "sub/deep/nested.md".to_string(),
            "deep content".to_string(),
        )
        .unwrap();
        assert!(result.doc_path.contains("nested.md"));
        // 父目录已创建
        assert!(dir.path().join("sub").join("deep").exists());
        // 文件已写入
        let written = fs::read_to_string(dir.path().join("sub").join("deep").join("nested.md")).unwrap();
        assert_eq!(written, "deep content");
    }

    #[test]
    fn test_agent_write_file_rejects_existing_file() {
        let dir = create_test_workspace();
        let ws = dir.path().to_string_lossy().to_string();
        // intro.md 已存在
        let err = agent_write_file(
            ws,
            "intro.md".to_string(),
            "overwrite attempt".to_string(),
        )
        .unwrap_err();
        assert_eq!(err, "file exists");
        // 原文件未被覆盖
        let original = fs::read_to_string(dir.path().join("intro.md")).unwrap();
        assert!(original.contains("Welcome to Murasaki"));
        assert!(!original.contains("overwrite attempt"));
    }

    #[test]
    fn test_agent_write_file_rejects_non_markdown() {
        let dir = TempDir::new().unwrap();
        let ws = dir.path().to_string_lossy().to_string();
        let err = agent_write_file(
            ws,
            "notes.txt".to_string(),
            "text content".to_string(),
        )
        .unwrap_err();
        assert!(err.contains("only markdown"));
    }

    #[test]
    fn test_agent_write_file_rejects_path_outside_workspace() {
        let dir = create_test_workspace();
        let ws = dir.path().to_string_lossy().to_string();
        let err = agent_write_file(
            ws.clone(),
            "../outside.md".to_string(),
            "escape attempt".to_string(),
        )
        .unwrap_err();
        assert_eq!(err, "path outside workspace");

        // 绝对路径也应被拒绝
        let abs_path = dir.path().join("intro.md").to_string_lossy().to_string();
        let err = agent_write_file(ws, abs_path, "abs attempt".to_string()).unwrap_err();
        assert_eq!(err, "path outside workspace");
    }

    #[test]
    fn test_agent_write_file_returns_absolute_path() {
        let dir = create_test_workspace();
        let ws = dir.path().to_string_lossy().to_string();
        let result = agent_write_file(
            ws,
            "created.md".to_string(),
            "content".to_string(),
        )
        .unwrap();
        // absolute_path 应指向实际磁盘路径
        assert!(result.absolute_path.ends_with("created.md"));
        assert!(PathBuf::from(&result.absolute_path).exists());
    }
}
