/// 系统语言探测命令（首启多语言，issue #141）
///
/// 首次启动时探测 OS 系统语言，作为界面语言默认值并持久化。
/// 仅当 settings.json 的 `language` 字段从未被写入时才触发一次。
///
/// 映射规则（大小写归一后匹配）：
/// - 原始系统 locale 含 `zh`（如 "zh-CN"/"zh-TW"）→ "zh-CN"
/// - 含 `ja`（如 "ja"/"ja-JP"）→ "ja"
/// - 其他语言（含 en、其他 locale、或 get_locale() 返回 None）→ "en"
///
/// 不读取 i18n.rs 的 SUPPORTED_LANGS（该常量正由另一任务改为从 JSON 生成），
/// 本命令内部硬编码上述映射即可。
/// 返回的字符串已是受支持语言（"zh-CN" / "ja" / "en"），前端可再经
/// mapSystemLocale 兜底归一。
#[tauri::command]
pub fn detect_system_locale() -> String {
    let raw = sys_locale::get_locale();
    map_system_locale(raw.as_deref())
}

/// 将原始系统 locale 字符串映射到受支持语言。
/// 单独抽出便于单元测试。返回 "zh-CN" / "ja" / "en"。
pub fn map_system_locale(raw: Option<&str>) -> String {
    let lower = raw.unwrap_or("").to_lowercase();
    if lower.contains("zh") {
        "zh-CN".to_string()
    } else if lower.contains("ja") {
        "ja".to_string()
    } else {
        "en".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::map_system_locale;

    #[test]
    fn zh_variants_map_to_zh_cn() {
        assert_eq!(map_system_locale(Some("zh-CN")), "zh-CN");
        assert_eq!(map_system_locale(Some("zh_TW")), "zh-CN");
        assert_eq!(map_system_locale(Some("ZH-Hant")), "zh-CN");
    }

    #[test]
    fn ja_variants_map_to_ja() {
        assert_eq!(map_system_locale(Some("ja")), "ja");
        assert_eq!(map_system_locale(Some("ja-JP")), "ja");
    }

    #[test]
    fn en_and_other_map_to_en() {
        assert_eq!(map_system_locale(Some("en-US")), "en");
        assert_eq!(map_system_locale(Some("fr-FR")), "en");
        assert_eq!(map_system_locale(Some("de")), "en");
        assert_eq!(map_system_locale(None), "en");
    }
}