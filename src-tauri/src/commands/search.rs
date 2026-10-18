use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use walkdir::WalkDir;
use crate::errors::{CommandError, ErrorCode};

/// 搜索匹配项
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub line_number: u32,
    pub line_content: String,
    pub context_before: Vec<String>,
    pub context_after: Vec<String>,
    /// 命中段在 line_content 内的字符偏移 [start, end)，供前端精确高亮
    pub ranges: Vec<(u32, u32)>,
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
    /// 是否因达到结果上限而被截断
    pub truncated: bool,
    /// 是否被用户取消（与 truncated 区分：取消不应提示「结果过多」）
    pub cancelled: bool,
}

/// 搜索选项
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
}

/// 搜索进度事件 payload
/// 通过 `search-progress` 事件推送给前端
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchProgressEvent {
    /// 已扫描文件数
    pub scanned_files: u32,
    /// 待扫描文件总数（首次发出后才知道）
    pub total_files: u32,
    /// 命中文件数（含内容或文件名命中）
    pub matched_files: u32,
    /// 命中行总数（仅内容命中）
    pub matched_count: u32,
    /// 关联的 cancel_token，前端用于过滤过期事件
    pub cancel_token: String,
}

/// 搜索结果增量事件 payload
/// 通过 `search-result-chunk` 事件推送给前端，每命中一个文件发出一次
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultChunkEvent {
    /// 关联的 cancel_token
    pub cancel_token: String,
    /// 本次命中的文件结果（内容匹配）
    pub result: Option<SearchResult>,
    /// 文件名命中（若该文件文件名也匹配，单独发出避免遗漏）
    pub filename_match: Option<String>,
}

/// 取消标记的存活时间：超时后自动清理，避免长期运行把集合撑大
const CANCEL_TOKEN_TTL: Duration = Duration::from_secs(300);

/// 搜索状态：保存已请求取消的 cancel_token（token → 登记时间）
/// search_workspace 在扫描循环中检查此集合，命中则提前返回
#[derive(Default)]
pub struct SearchState {
    pub cancel_tokens: Mutex<HashMap<String, Instant>>,
}

/// 清掉超过 TTL 的取消标记（有界内存）
fn purge_expired_tokens(tokens: &mut HashMap<String, Instant>, now: Instant) {
    tokens.retain(|_, at| now.saturating_duration_since(*at) < CANCEL_TOKEN_TTL);
}

/// 构造搜索正则：根据选项把用户查询编译为 Regex
fn build_search_regex(query: &str, options: &SearchOptions) -> Result<Regex, CommandError> {
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
    Regex::new(&format!("{}{}", flags, pattern))
        .map_err(|e| CommandError::new(ErrorCode::InvalidArgument).with_param("detail", e.to_string()))
}

/// 检查文件名是否匹配查询
fn filename_matches(file_path: &Path, regex: &Regex) -> bool {
    let name = file_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    regex.is_match(&name)
}

/// 将字节偏移转换为 UTF-16 码元偏移（regex 返回字节偏移；前端 JS 按 UTF-16 码元索引切片高亮）
fn byte_to_utf16_offset(line: &str, byte: usize) -> u32 {
    line.get(..byte).map(|s| s.encode_utf16().count()).unwrap_or(0) as u32
}

/// 文件内每扫描多少行检查一次取消（大文件也能及时中断）
const CANCEL_CHECK_LINES: usize = 200;
/// 单个文件参与内容搜索的大小上限（超过直接跳过，避免整读巨型文件）
const MAX_SEARCH_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// 在单个文件内容中搜索匹配行。
///
/// 返回 `(命中列表, 是否被取消)`；取消后返回已扫到的部分结果。
fn search_in_content(
    content: &str,
    regex: &Regex,
    is_cancelled: &dyn Fn() -> bool,
) -> (Vec<SearchMatch>, bool) {
    let lines: Vec<&str> = content.lines().collect();
    let mut matches = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if i % CANCEL_CHECK_LINES == 0 && is_cancelled() {
            return (matches, true);
        }
        if regex.is_match(line) {
            let line_number = (i + 1) as u32;
            // 命中段：按当前正则（含大小写/全词选项）精确计算 UTF-16 码元偏移
            let ranges: Vec<(u32, u32)> = regex
                .find_iter(line)
                .map(|m| (byte_to_utf16_offset(line, m.start()), byte_to_utf16_offset(line, m.end())))
                .collect();
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
                ranges,
            });
        }
    }
    (matches, false)
}

/// 判断是否为 Markdown 文件
fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_lowercase().as_str(), "md" | "markdown" | "mdown" | "mkd"))
        .unwrap_or(false)
}

/// 默认结果上限：避免超大工作区卡顿
const DEFAULT_MAX_RESULTS: u32 = 1000;
/// 每扫描多少个文件发出一次进度事件（避免事件风暴）
const PROGRESS_EMIT_INTERVAL: u32 = 10;

/// 跨文件搜索：在工作区所有 .md 文件中搜索内容，同时搜索文件名
///
/// 改造点（0.4.0）：
/// - `async fn`，避免长搜索阻塞调用线程
/// - 接收 `cancel_token`，前端可通过 `cancel_search` 中断进行中的搜索
/// - 接收 `max_results`，达到上限立即停止并标记 `truncated=true`
/// - 通过 `search-progress` 事件推送扫描进度
/// - 通过 `search-result-chunk` 事件推送增量结果（边搜边显示）
/// - 最终返回 SearchResponse 作为权威结果（前端可用以覆盖增量结果保证一致）
#[tauri::command]
pub async fn search_workspace(
    window: WebviewWindow,
    app: AppHandle,
    workspace: String,
    query: String,
    options: Option<SearchOptions>,
    cancel_token: Option<String>,
    max_results: Option<u32>,
) -> Result<SearchResponse, CommandError> {
    if query.trim().is_empty() {
        return Ok(SearchResponse {
            content_results: Vec::new(),
            filename_results: Vec::new(),
            truncated: false,
            cancelled: false,
        });
    }
    let opts = options.unwrap_or_default();
    let regex = build_search_regex(&query, &opts)?;
    crate::security::policy().ensure_read(&workspace)?;
    let workspace_path = PathBuf::from(&workspace);
    if !workspace_path.exists() {
        return Err(CommandError::path(ErrorCode::NotFound, &workspace));
    }

    let max_results = max_results.unwrap_or(DEFAULT_MAX_RESULTS).max(1);
    let token = cancel_token.unwrap_or_default();
    let label = window.label().to_string();

    // WalkDir / Regex / 文件读取都是同步且可能耗时：放到阻塞线程池，
    // 否则会占住 tokio worker，让同一进程里的其它异步命令排队。
    tauri::async_runtime::spawn_blocking(move || {
        search_blocking(&app, &label, &workspace_path, &regex, token, max_results)
    })
    .await
    .map_err(|e| CommandError::internal(format!("search join: {e}")))?
}

/// 是否属于搜索应跳过的噪音目录（与文件树共用同一份清单）
fn is_ignored(root: &Path, path: &Path) -> bool {
    let relative = path.strip_prefix(root).unwrap_or(path);
    relative.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(crate::commands::files::is_noise)
    })
}

/// 同步扫描实现（运行在阻塞线程池里）：只负责事件接线与取消标记清理。
fn search_blocking(
    app: &AppHandle,
    label: &str,
    workspace: &Path,
    regex: &Regex,
    token: String,
    max_results: u32,
) -> Result<SearchResponse, CommandError> {
    let has_token = !token.is_empty();
    let cancel_state = app.try_state::<SearchState>();

    // 顺带清理过期的取消标记（有界内存）
    if let Some(state) = cancel_state.as_deref() {
        if let Ok(mut guard) = state.cancel_tokens.lock() {
            purge_expired_tokens(&mut guard, Instant::now());
        }
    }

    let is_cancelled = || -> bool {
        if !has_token {
            return false;
        }
        cancel_state
            .as_deref()
            .and_then(|s| s.cancel_tokens.lock().ok())
            .map(|guard| guard.contains_key(&token))
            .unwrap_or(false)
    };

    let response = scan_workspace(
        workspace,
        regex,
        max_results,
        &is_cancelled,
        |scanned, total, matched_files, matched_count| {
            if has_token {
                let _ = app.emit_to(
                    label,
                    "search-progress",
                    SearchProgressEvent {
                        scanned_files: scanned,
                        total_files: total,
                        matched_files,
                        matched_count,
                        cancel_token: token.clone(),
                    },
                );
            }
        },
        |result, filename_match| {
            if has_token {
                let _ = app.emit_to(
                    label,
                    "search-result-chunk",
                    SearchResultChunkEvent {
                        cancel_token: token.clone(),
                        result,
                        filename_match,
                    },
                );
            }
        },
    );

    // 清理自身的 cancel_token（若已请求取消则保留标记由 cancel_search 自清理；这里仅消费未取消的）
    if has_token {
        if let Some(state) = cancel_state.as_deref() {
            if let Ok(mut guard) = state.cancel_tokens.lock() {
                guard.remove(&token);
            }
        }
    }

    Ok(response)
}

/// 扫描实现：不依赖 Tauri 类型，单测与生产共用（避免测试复制一份会漂移的逻辑）。
///
/// - `on_progress(scanned, total, matched_files, matched_count)`
/// - `on_chunk(result, filename_match)`：增量命中（内容结果 / 文件名）
fn scan_workspace(
    workspace: &Path,
    regex: &Regex,
    max_results: u32,
    is_cancelled: &dyn Fn() -> bool,
    mut on_progress: impl FnMut(u32, u32, u32, u32),
    mut on_chunk: impl FnMut(Option<SearchResult>, Option<String>),
) -> SearchResponse {
    // 先收集所有 .md 文件路径，用于 total_files 进度；噪音目录直接剪枝
    let mut md_files: Vec<PathBuf> = Vec::new();
    let mut cancelled = false;
    let mut truncated = false;
    for entry in WalkDir::new(workspace)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !is_ignored(workspace, e.path()))
    {
        if is_cancelled() {
            cancelled = true;
            break;
        }
        let Ok(entry) = entry else {
            continue;
        };
        if entry.file_type().is_file() && is_markdown(entry.path()) {
            md_files.push(entry.path().to_path_buf());
        }
    }
    let total_files = md_files.len() as u32;

    let mut content_results: Vec<SearchResult> = Vec::new();
    let mut filename_results: Vec<String> = Vec::new();
    let mut seen_filenames: HashSet<String> = HashSet::new();
    let mut matched_count: u32 = 0;

    for (idx, path) in md_files.iter().enumerate() {
        let scanned = (idx + 1) as u32;
        // 检查取消
        if is_cancelled() {
            cancelled = true;
            break;
        }

        // 文件名匹配
        if filename_matches(path, regex) {
            let file_path = path.to_string_lossy().to_string();
            if seen_filenames.insert(file_path.clone()) {
                filename_results.push(file_path.clone());
                on_chunk(None, Some(file_path));
            }
        }

        // 跳过超大文件：整读几 MB 的正文会拖慢整次搜索
        let too_large = fs::metadata(path)
            .map(|meta| meta.len() > MAX_SEARCH_FILE_BYTES)
            .unwrap_or(false);
        if too_large {
            if scanned % PROGRESS_EMIT_INTERVAL == 0 || idx + 1 == md_files.len() {
                on_progress(
                    scanned,
                    total_files,
                    content_results.len() as u32,
                    matched_count,
                );
            }
            continue;
        }

        // 内容匹配
        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => {
                // 即便读取失败也推送进度
                if scanned % PROGRESS_EMIT_INTERVAL == 0 || idx + 1 == md_files.len() {
                    on_progress(
                        scanned,
                        total_files,
                        content_results.len() as u32,
                        matched_count,
                    );
                }
                continue;
            }
        };
        let (matches, was_cancelled) = search_in_content(&content, regex, is_cancelled);
        if was_cancelled {
            cancelled = true;
        }
        if !matches.is_empty() {
            matched_count = matched_count.saturating_add(matches.len() as u32);
            let result = SearchResult {
                file_path: path.to_string_lossy().to_string(),
                matches,
            };
            on_chunk(Some(result.clone()), None);
            content_results.push(result);

            // 检查上限
            if matched_count >= max_results {
                truncated = true;
                on_progress(
                    scanned,
                    total_files,
                    content_results.len() as u32,
                    matched_count,
                );
                break;
            }
        }

        if was_cancelled {
            on_progress(
                scanned,
                total_files,
                content_results.len() as u32,
                matched_count,
            );
            break;
        }

        // 推送进度（每 PROGRESS_EMIT_INTERVAL 个文件一次 + 最后一次）
        if scanned % PROGRESS_EMIT_INTERVAL == 0 || idx + 1 == md_files.len() {
            on_progress(
                scanned,
                total_files,
                content_results.len() as u32,
                matched_count,
            );
        }
    }

    SearchResponse {
        content_results,
        filename_results,
        truncated,
        cancelled,
    }
}

/// 请求取消指定 cancel_token 关联的搜索
/// 前端在新搜索前或用户手动取消时调用
#[tauri::command]
pub fn cancel_search(app: AppHandle, cancel_token: String) -> Result<(), CommandError> {
    if cancel_token.is_empty() {
        return Ok(());
    }
    let state = app.state::<SearchState>();
    let now = Instant::now();
    let mut guard = state
        .cancel_tokens
        .lock()
        .map_err(|e| CommandError::internal(format!("search lock: {e}")))?;
    // 顺手清掉过期标记：token 集合不会随运行时长无限增长
    purge_expired_tokens(&mut guard, now);
    guard.insert(cancel_token, now);
    Ok(())
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

    /// 测试辅助：直接调用生产扫描实现（不依赖 AppHandle / 不 emit 事件）。
    /// `_cancel_token` 保留只为不改动既有调用点；测试中取消恒为 false。
    fn run_search(
        workspace: String,
        query: String,
        options: Option<SearchOptions>,
        _cancel_token: Option<String>,
        max_results: Option<u32>,
    ) -> SearchResponse {
        if query.trim().is_empty() {
            return SearchResponse {
                content_results: Vec::new(),
                filename_results: Vec::new(),
                truncated: false,
                cancelled: false,
            };
        }
        let opts = options.unwrap_or_default();
        let regex = build_search_regex(&query, &opts).unwrap();
        let workspace_path = PathBuf::from(&workspace);
        let max_results = max_results.unwrap_or(DEFAULT_MAX_RESULTS).max(1);
        scan_workspace(
            &workspace_path,
            &regex,
            max_results,
            &|| false,
            |_, _, _, _| {},
            |_, _| {},
        )
    }

    #[test]
    fn test_search_content_basic() {
        let dir = create_test_workspace();
        let resp = run_search(
            dir.path().to_string_lossy().to_string(),
            "Murasaki".to_string(),
            None,
            None,
            None,
        );
        // 3 个 .md 文件都包含 Murasaki
        assert_eq!(resp.content_results.len(), 3);
        assert!(!resp.truncated);
    }

    #[test]
    fn test_search_content_case_insensitive_default() {
        let dir = create_test_workspace();
        let resp = run_search(
            dir.path().to_string_lossy().to_string(),
            "murasaki".to_string(),
            None,
            None,
            None,
        );
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
        let resp = run_search(
            dir.path().to_string_lossy().to_string(),
            "murasaki".to_string(),
            Some(opts),
            None,
            None,
        );
        // 大小写敏感：只有小写 "murasaki" 不存在，0 结果
        assert_eq!(resp.content_results.len(), 0);
    }

    #[test]
    fn test_search_filename() {
        let dir = create_test_workspace();
        let resp = run_search(
            dir.path().to_string_lossy().to_string(),
            "notes".to_string(),
            None,
            None,
            None,
        );
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
        let resp = run_search(
            dir.path().to_string_lossy().to_string(),
            "Mura.*editor".to_string(),
            Some(opts),
            None,
            None,
        );
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
        let resp = run_search(
            dir.path().to_string_lossy().to_string(),
            "Murasaki".to_string(),
            Some(opts),
            None,
            None,
        );
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
        let resp = run_search(
            dir.path().to_string_lossy().to_string(),
            "".to_string(),
            None,
            None,
            None,
        );
        assert!(resp.content_results.is_empty());
        assert!(resp.filename_results.is_empty());
        assert!(!resp.truncated);
    }

    #[test]
    fn test_search_context_lines() {
        let dir = create_test_workspace();
        let resp = run_search(
            dir.path().to_string_lossy().to_string(),
            "Welcome".to_string(),
            None,
            None,
            None,
        );
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
    fn test_search_ranges() {
        let dir = create_test_workspace();
        let resp = run_search(
            dir.path().to_string_lossy().to_string(),
            "Murasaki".to_string(),
            None,
            None,
            None,
        );
        // intro.md 第 3 行 "Welcome to Murasaki, a markdown editor."
        let result = resp
            .content_results
            .iter()
            .find(|r| r.file_path.ends_with("intro.md"))
            .unwrap();
        let m = &result.matches[0];
        assert_eq!(m.line_number, 3);
        // "Welcome to " 为 11 个字符，"Murasaki" 占 [11, 19)
        assert_eq!(m.ranges, vec![(11, 19)]);
    }

    #[test]
    fn test_search_ranges_multiple_hits_in_line() {
        let dir = create_test_workspace();
        // notes.md 第 3 行 "Murasaki is lightweight." 同时命中 "Mura" 与 "light" → 一行两处
        let opts = SearchOptions {
            regex: true,
            case_sensitive: false,
            whole_word: false,
        };
        let resp = run_search(
            dir.path().to_string_lossy().to_string(),
            "Mura|light".to_string(),
            Some(opts),
            None,
            None,
        );
        let result = resp
            .content_results
            .iter()
            .find(|r| r.file_path.ends_with("notes.md"))
            .unwrap();
        let m = &result.matches[0];
        assert_eq!(m.line_number, 3);
        // "Mura" 占 [0, 4)；"light" 占 [12, 17)（UTF-16 码元偏移，与前端 slice 一致）
        assert_eq!(m.ranges, vec![(0, 4), (12, 17)]);
    }

    #[test]
    fn test_byte_to_utf16_offset() {
        // 😀 是 1 个标量值但占 2 个 UTF-16 码元；"Mura" 从码元偏移 3 开始（😀=2 + x=1）
        let line = "😀xMura";
        let byte_start = line.find("Mura").unwrap();
        assert_eq!(byte_to_utf16_offset(line, byte_start), 3);
        assert_eq!(byte_to_utf16_offset(line, byte_start + "Mura".len()), 7);
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

    #[test]
    fn test_search_max_results_truncation() {
        let dir = create_test_workspace();
        // intro.md 含 1 处 Murasaki, notes.md 含 1 处, deep.md 含 1 处
        // 设置 max_results=2：扫描到第二个命中后达到上限，截断
        let resp = run_search(
            dir.path().to_string_lossy().to_string(),
            "Murasaki".to_string(),
            None,
            None,
            Some(2),
        );
        assert!(resp.truncated);
        // 命中行数应不超过 2（取等号）
        let total: usize = resp.content_results.iter().map(|r| r.matches.len()).sum();
        assert!(total <= 2);
    }

    #[test]
    fn test_search_max_results_not_truncated_when_below_limit() {
        let dir = create_test_workspace();
        let resp = run_search(
            dir.path().to_string_lossy().to_string(),
            "Murasaki".to_string(),
            None,
            None,
            Some(1000),
        );
        assert!(!resp.truncated);
        assert_eq!(resp.content_results.len(), 3);
    }

    #[test]
    fn search_in_content_cancels_between_lines() {
        // 每 200 行检查一次取消：取消后返回已扫到的部分结果并标记 cancelled
        let content = "hit\n".repeat(450);
        let regex = Regex::new("hit").unwrap();
        let calls = std::cell::Cell::new(0);
        let is_cancelled = || {
            let n = calls.get();
            calls.set(n + 1);
            n >= 1
        };

        let (matches, cancelled) = search_in_content(&content, &regex, &is_cancelled);

        assert!(cancelled);
        // 第一次检查（第 0 行）放行，第二次检查（第 200 行）命中取消
        assert_eq!(matches.len(), 200);
    }

    #[test]
    fn search_state_purges_expired_cancel_tokens() {
        let start = Instant::now();
        let mut tokens = HashMap::new();
        // 用「把 now 往后推」构造过期，避免依赖机器已开机时长
        tokens.insert("stale".to_string(), start);
        tokens.insert(
            "fresh".to_string(),
            start + CANCEL_TOKEN_TTL + Duration::from_millis(500),
        );

        purge_expired_tokens(
            &mut tokens,
            start + CANCEL_TOKEN_TTL + Duration::from_secs(1),
        );

        assert!(!tokens.contains_key("stale"));
        assert!(tokens.contains_key("fresh"));
    }

    #[test]
    fn is_ignored_skips_noise_dirs_below_workspace() {
        let root = Path::new("/ws");
        assert!(is_ignored(root, Path::new("/ws/.git/objects/ab")));
        assert!(is_ignored(root, Path::new("/ws/node_modules/pkg/a.md")));
        assert!(!is_ignored(root, Path::new("/ws/docs/a.md")));
    }

    #[test]
    fn is_ignored_does_not_reject_workspace_under_noise_named_dir() {
        // 工作区本身在 node_modules 下：祖先目录名不应让搜索全空
        let root = Path::new("/repo/node_modules/pkg");
        assert!(!is_ignored(root, Path::new("/repo/node_modules/pkg/a.md")));
    }
}
