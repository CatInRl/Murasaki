use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use serde::{Deserialize, Serialize};

/// 大纲项：与前端 OutlineItem 类型对齐
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineItem {
    pub level: u8,       // 1-6（对应 # ~ ######）
    pub text: String,    // 标题文本（去除 # 前缀）
    pub line: u32,       // 1-indexed 行号
}

/// 缓存条目：(mtime_millis, outline)
type CacheEntry = (u128, Vec<OutlineItem>);

/// 全局大纲缓存：文件路径 → (mtime, outline)
static OUTLINE_CACHE: Mutex<Option<HashMap<String, CacheEntry>>> = Mutex::new(None);

fn get_cache() -> std::sync::MutexGuard<'static, Option<HashMap<String, CacheEntry>>> {
    let mut guard = OUTLINE_CACHE.lock().unwrap();
    if guard.is_none() {
        *guard = Some(HashMap::new());
    }
    guard
}

/// 解析单行为标题：返回 (level, text) 或 None
/// 仅匹配行首 1-6 个 # 后跟空格或行尾的标题
fn parse_heading_line(line: &str) -> Option<(u8, String)> {
    let trimmed = line.trim_start();
    // 统计行首 # 数量
    let hashes = trimmed.chars().take_while(|&c| c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &trimmed[hashes..];
    // # 后必须紧跟空格或行尾（避免匹配 ##foo 这类非标题）
    if !rest.is_empty() && !rest.starts_with(' ') && !rest.starts_with('\t') {
        return None;
    }
    let text = rest.trim().trim_end_matches('#').trim().to_string();
    // 空标题不算（如 "## "）
    if text.is_empty() {
        return None;
    }
    Some((hashes as u8, text))
}

/// 解析 Markdown 文本，提取所有标题
/// 跳过代码块内的 # 行（``` 或 ~~~ 包围）
pub fn parse_outline_from_text(content: &str) -> Vec<OutlineItem> {
    let mut items = Vec::new();
    let mut in_code_block = false;
    let mut code_fence: Option<&str> = None;

    for (i, line) in content.lines().enumerate() {
        let line_no = (i + 1) as u32;

        // 检测代码块围栏（``` 或 ~~~）
        let trimmed = line.trim_start();
        if let Some(fence) = code_fence {
            // 在代码块内，检查是否是结束围栏
            if trimmed.starts_with(fence) {
                in_code_block = false;
                code_fence = None;
            }
            continue;
        } else if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code_block = true;
            code_fence = Some(if trimmed.starts_with("```") { "```" } else { "~~~" });
            continue;
        }

        if in_code_block {
            continue;
        }

        if let Some((level, text)) = parse_heading_line(line) {
            items.push(OutlineItem {
                level,
                text,
                line: line_no,
            });
        }
    }

    items
}

/// 解析 Markdown 文件大纲（基于 mtime 缓存）
/// path: 文件绝对路径
/// 返回 OutlineItem 数组
#[tauri::command]
pub fn parse_outline(path: String) -> Result<Vec<OutlineItem>, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    if !p.is_file() {
        return Err(format!("不是文件: {}", path));
    }

    // 获取 mtime
    let metadata = fs::metadata(&p).map_err(|e| e.to_string())?;
    let mtime = metadata
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();

    // 查缓存
    {
        let cache = get_cache();
        let cache = cache.as_ref().unwrap();
        if let Some((cached_mtime, cached_outline)) = cache.get(&path) {
            if *cached_mtime == mtime {
                return Ok(cached_outline.clone());
            }
        }
    }

    // 读文件并解析
    let content = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let outline = parse_outline_from_text(&content);

    // 写缓存
    {
        let mut cache = get_cache();
        let cache = cache.as_mut().unwrap();
        cache.insert(path, (mtime, outline.clone()));
    }

    Ok(outline)
}

/// 从编辑器实时文本解析大纲（编辑态刷新用，不访问磁盘、不依赖 mtime）
/// 与 `parse_outline` 共用 `parse_outline_from_text`，保证单一解析源
#[tauri::command]
pub fn parse_outline_str(text: String) -> Vec<OutlineItem> {
    parse_outline_from_text(&text)
}

/// 清除指定文件的大纲缓存（文件被删除/重命名时调用）
#[tauri::command]
pub fn invalidate_outline_cache(path: String) -> Result<(), String> {
    let mut cache = get_cache();
    let cache = cache.as_mut().unwrap();
    cache.remove(&path);
    Ok(())
}

/// 清除全部大纲缓存
#[tauri::command]
pub fn clear_outline_cache() -> Result<(), String> {
    let mut cache = get_cache();
    let cache = cache.as_mut().unwrap();
    cache.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn items(text: &str) -> Vec<OutlineItem> {
        parse_outline_str(text.to_string())
    }

    fn summary(items: &[OutlineItem]) -> Vec<(u32, u8, String)> {
        items
            .iter()
            .map(|i| (i.line, i.level, i.text.clone()))
            .collect()
    }

    #[test]
    fn 解析标题层级与行号() {
        let text = "# 一级\n正文\n## 二级\n### 三级";
        let got = summary(&items(text));
        assert_eq!(
            got,
            vec![
                (1, 1, "一级".to_string()),
                (3, 2, "二级".to_string()),
                (4, 3, "三级".to_string()),
            ]
        );
    }

    #[test]
    fn 空标题不解析() {
        let text = "## \n#\n## 有效标题";
        let got = summary(&items(text));
        assert_eq!(got, vec![(3, 2, "有效标题".to_string())]);
    }

    #[test]
    fn 代码块内井号跳过() {
        let text = "# 标题\n```\n# 这不是标题\n```\n## 结论";
        let got = summary(&items(text));
        assert_eq!(
            got,
            vec![(1, 1, "标题".to_string()), (5, 2, "结论".to_string())]
        );
    }

    #[test]
    fn 波浪线代码块内井号跳过() {
        let text = "# 标题\n~~~\n### 跳过\n~~~\n## 保留";
        let got = summary(&items(text));
        assert_eq!(
            got,
            vec![(1, 1, "标题".to_string()), (5, 2, "保留".to_string())]
        );
    }

    #[test]
    fn 超出六级不算标题() {
        let text = "####### 七级\n## 正常";
        let got = summary(&items(text));
        assert_eq!(got, vec![(2, 2, "正常".to_string())]);
    }

    #[test]
    fn 无空格井号不算标题() {
        let text = "#不用空格\n## 正常";
        let got = summary(&items(text));
        assert_eq!(got, vec![(2, 2, "正常".to_string())]);
    }

    #[test]
    fn 与磁盘命令共用同一解析源() {
        // 相同文本结果一致（parse_outline_from_text 即 parse_outline 内部解析函数）
        let text = "# A\n```\n# hidden\n```\n## B";
        let via_str = summary(&items(text));
        let via_disk = summary(&parse_outline_from_text(text));
        assert_eq!(via_str, via_disk);
    }
}
