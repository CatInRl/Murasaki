use std::fs;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use regex::Regex;
use walkdir::WalkDir;

/// 搜索匹配项
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub line_number: u32,
    pub line_content: String,
    pub context_before: Vec<String>,
    pub context_after: Vec<String>,
}

/// 单个文件的搜索结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub file_path: String,
    pub matches: Vec<SearchMatch>,
}

/// 搜索响应：内容匹配 + 文件名匹配
/// 文件名匹配仅为路径字符串（无额外字段，避免冗余包装类型）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub content_results: Vec<SearchResult>,
    pub filename_results: Vec<String>,
}

/// 搜索选项
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
}

/// 构造搜索正则：根据选项把用户查询编译为 Regex
fn build_search_regex(query: &str, options: &SearchOptions) -> Result<Regex, String> {
    let pattern = if options.regex {
        query.to_string()
    } else {
        // 转义正则特殊字符
        regex::escape(query)
    };
    let pattern = if options.whole_word {
        format!(r"\b{}\b", pattern)
    } else {
        pattern
    };
    let flags = if options.case_sensitive { "" } else { "(?i)" };
    Regex::new(&format!("{}{}", flags, pattern)).map_err(|e| e.to_string())
}

/// 检查文件名是否匹配查询
fn filename_matches(file_path: &Path, regex: &Regex) -> bool {
    let name = file_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    regex.is_match(&name)
}

/// 在单个文件内容中搜索匹配行
fn search_in_content(
    content: &str,
    regex: &Regex,
) -> Vec<SearchMatch> {
    let lines: Vec<&str> = content.lines().collect();
    let mut matches = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if regex.is_match(line) {
            let line_number = (i + 1) as u32;
            // 上下文：前 2 行 + 后 2 行
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
            matches.push(SearchMatch {
                line_number,
                line_content: line.to_string(),
                context_before,
                context_after,
            });
        }
    }
    matches
}

/// 判断是否为 Markdown 文件
fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_lowercase().as_str(), "md" | "markdown" | "mdown" | "mkd"))
        .unwrap_or(false)
}

/// 跨文件搜索：在工作区所有 .md 文件中搜索内容，同时搜索文件名
/// 返回 SearchResponse（content_results + filename_results）
#[tauri::command]
pub fn search_workspace(
    workspace: String,
    query: String,
    options: Option<SearchOptions>,
) -> Result<SearchResponse, String> {
    if query.trim().is_empty() {
        return Ok(SearchResponse {
            content_results: Vec::new(),
            filename_results: Vec::new(),
        });
    }
    let opts = options.unwrap_or_default();
    let regex = build_search_regex(&query, &opts)?;
    let workspace_path = PathBuf::from(&workspace);
    if !workspace_path.exists() {
        return Err(format!("工作区不存在: {}", workspace));
    }

    let mut content_results: Vec<SearchResult> = Vec::new();
    let mut filename_results: Vec<String> = Vec::new();
    let mut seen_filenames: std::collections::HashSet<String> = std::collections::HashSet::new();

    for entry in WalkDir::new(&workspace_path)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        // 仅搜索 Markdown 文件
        if !is_markdown(path) {
            continue;
        }

        // 文件名匹配
        if filename_matches(path, &regex) {
            let file_path = path.to_string_lossy().to_string();
            if seen_filenames.insert(file_path.clone()) {
                filename_results.push(file_path);
            }
        }

        // 内容匹配
        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let matches = search_in_content(&content, &regex);
        if !matches.is_empty() {
            content_results.push(SearchResult {
                file_path: path.to_string_lossy().to_string(),
                matches,
            });
        }
    }

    Ok(SearchResponse {
        content_results,
        filename_results,
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
        // 创建测试文件
        // intro.md: "Murasaki" 和 "editor" 在同一行（供 regex 测试），
        // "Welcome" 后有 2 行内容（供 context_lines 测试）
        fs::write(
            dir.path().join("intro.md"),
            "# Introduction\n\nWelcome to Murasaki, a markdown editor.\nIt supports search and more.\nAdditional context line.\n",
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
            "# Deep\n\nMurasaki deep content here.\n",
        )
        .unwrap();
        // 非 markdown 文件
        fs::write(dir.path().join("readme.txt"), "Murasaki txt\n").unwrap();
        dir
    }

    #[test]
    fn test_search_content_basic() {
        let dir = create_test_workspace();
        let resp = search_workspace(
            dir.path().to_string_lossy().to_string(),
            "Murasaki".to_string(),
            None,
        )
        .unwrap();
        // 3 个 .md 文件都包含 Murasaki
        assert_eq!(resp.content_results.len(), 3);
    }

    #[test]
    fn test_search_content_case_insensitive_default() {
        let dir = create_test_workspace();
        let resp = search_workspace(
            dir.path().to_string_lossy().to_string(),
            "murasaki".to_string(),
            None,
        )
        .unwrap();
        // 默认大小写不敏感
        assert_eq!(resp.content_results.len(), 3);
    }

    #[test]
    fn test_search_content_case_sensitive() {
        let dir = create_test_workspace();
        let opts = SearchOptions {
            regex: false,
            case_sensitive: true,
            whole_word: false,
        };
        let resp = search_workspace(
            dir.path().to_string_lossy().to_string(),
            "murasaki".to_string(),
            Some(opts),
        )
        .unwrap();
        // 大小写敏感：只有小写 "murasaki" 不存在，0 结果
        assert_eq!(resp.content_results.len(), 0);
    }

    #[test]
    fn test_search_filename() {
        let dir = create_test_workspace();
        let resp = search_workspace(
            dir.path().to_string_lossy().to_string(),
            "notes".to_string(),
            None,
        )
        .unwrap();
        // 文件名匹配 notes.md
        assert_eq!(resp.filename_results.len(), 1);
        assert!(resp.filename_results[0].ends_with("notes.md"));
    }

    #[test]
    fn test_search_regex() {
        let dir = create_test_workspace();
        let opts = SearchOptions {
            regex: true,
            case_sensitive: false,
            whole_word: false,
        };
        let resp = search_workspace(
            dir.path().to_string_lossy().to_string(),
            "Mura.*editor".to_string(),
            Some(opts),
        )
        .unwrap();
        // 只有 intro.md 含 "Murasaki" + "editor" 在同一行
        assert_eq!(resp.content_results.len(), 1);
        assert!(resp.content_results[0].file_path.ends_with("intro.md"));
    }

    #[test]
    fn test_search_whole_word() {
        let dir = create_test_workspace();
        fs::write(
            dir.path().join("sub").join("deep.md"),
            "# Deep\n\nMurasakiXXX content here.\n",
        )
        .unwrap();
        let opts = SearchOptions {
            regex: false,
            case_sensitive: false,
            whole_word: true,
        };
        let resp = search_workspace(
            dir.path().to_string_lossy().to_string(),
            "Murasaki".to_string(),
            Some(opts),
        )
        .unwrap();
        // whole_word: MurasakiXXX 不算 Murasaki 匹配
        // intro.md 和 notes.md 仍包含独立的 Murasaki
        assert!(resp.content_results.iter().any(|r| r.file_path.ends_with("intro.md")));
        assert!(resp.content_results.iter().any(|r| r.file_path.ends_with("notes.md")));
        // deep.md 中是 MurasakiXXX，不应匹配
        assert!(!resp.content_results.iter().any(|r| r.file_path.ends_with("deep.md")));
    }

    #[test]
    fn test_search_empty_query() {
        let dir = create_test_workspace();
        let resp = search_workspace(
            dir.path().to_string_lossy().to_string(),
            "".to_string(),
            None,
        )
        .unwrap();
        assert!(resp.content_results.is_empty());
        assert!(resp.filename_results.is_empty());
    }

    #[test]
    fn test_search_context_lines() {
        let dir = create_test_workspace();
        let resp = search_workspace(
            dir.path().to_string_lossy().to_string(),
            "Welcome".to_string(),
            None,
        )
        .unwrap();
        let result = resp.content_results.iter().find(|r| r.file_path.ends_with("intro.md")).unwrap();
        let m = &result.matches[0];
        assert_eq!(m.line_number, 3);
        // context_before: 前 2 行
        assert_eq!(m.context_before.len(), 2);
        assert_eq!(m.context_before[0], "# Introduction");
        assert_eq!(m.context_before[1], "");
        // context_after: 后 2 行
        assert_eq!(m.context_after.len(), 2);
        assert_eq!(m.context_after[0], "It supports search and more.");
        assert_eq!(m.context_after[1], "Additional context line.");
    }

    #[test]
    fn test_build_search_regex_plain() {
        let opts = SearchOptions::default();
        let re = build_search_regex("hello.world", &opts).unwrap();
        // 非正则模式：点号被转义
        assert!(re.is_match("hello.world"));
        assert!(!re.is_match("helloXworld"));
    }

    #[test]
    fn test_build_search_regex_regex_mode() {
        let opts = SearchOptions {
            regex: true,
            case_sensitive: false,
            whole_word: false,
        };
        let re = build_search_regex("hello.world", &opts).unwrap();
        // 正则模式：点号匹配任意字符
        assert!(re.is_match("helloXworld"));
        assert!(re.is_match("hello.world"));
    }

    #[test]
    fn test_build_search_regex_whole_word() {
        let opts = SearchOptions {
            regex: false,
            case_sensitive: false,
            whole_word: true,
        };
        let re = build_search_regex("hello", &opts).unwrap();
        assert!(re.is_match("hello world"));
        assert!(!re.is_match("helloworld"));
    }
}
