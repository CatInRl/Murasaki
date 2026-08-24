fn main() {
    // 必须先调用 tauri_build::build()：
    // 负责嵌入 Windows 应用清单（Common Controls v6 依赖）与资源生成。
    // 缺省会导致 comctl32 回退到 v5，运行时报“无法定位输入点 TaskDialogIndirect”。
    tauri_build::build();

    let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let locales_dir = manifest_dir.join("../src/locales");

    // 遍历 src/locales 下所有语言目录（zh-CN / en / ja ...）
    let mut langs: Vec<String> = Vec::new();
    let mut entries: Vec<(String, String, String)> = Vec::new();

    let dir = std::fs::read_dir(&locales_dir).expect("无法读取 src/locales 目录");
    for entry in dir.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let lang = entry.file_name().to_string_lossy().into_owned();
        let menu_file = path.join("menu.json");
        if !menu_file.exists() {
            continue;
        }
        // 修改 menu.json 时触发重新生成
        println!("cargo:rerun-if-changed={}", menu_file.display());

        langs.push(lang.clone());
        let text = std::fs::read_to_string(&menu_file).expect("读取 menu.json 失败");
        let value: serde_json::Value =
            serde_json::from_str(&text).expect("解析 menu.json 失败");

        // 展平嵌套 JSON，收集所有「点号 key → 字符串值」
        flatten(&lang, "", &value, &mut entries);
    }

    // 保证输出顺序稳定
    langs.sort();

    let out_dir = std::env::var("OUT_DIR").expect("缺少 OUT_DIR 环境变量");
    let out_file = std::path::Path::new(&out_dir).join("menu_locales.rs");

    let mut rust = String::new();
    rust.push_str("/// 由 build.rs 从 src/locales/**/menu.json 自动生成，勿手改\n");
    let lang_list: Vec<String> = langs
        .iter()
        .map(|l| format!("\"{}\"", escape(l)))
        .collect();
    rust.push_str(&format!(
        "pub const SUPPORTED_LANGS: &[&str] = &[{}];\n",
        lang_list.join(", ")
    ));

    // 可按语言排序，方便 menu.locales 查找时提前 break
    entries.sort();

    rust.push_str("pub static MENU_TEXTS: &[(&str, &str, &str)] = &[\n");
    for (lang, key, label) in &entries {
        rust.push_str(&format!(
            "    (\"{}\", \"{}\", \"{}\"),\n",
            escape(lang),
            escape(key),
            escape(label)
        ));
    }
    rust.push_str("];\n");

    std::fs::write(&out_file, rust).expect("写入 menu_locales.rs 失败");
}

/// 递归展平 JSON。仅当叶子为字符串时收录。
fn flatten(lang: &str, prefix: &str, value: &serde_json::Value, out: &mut Vec<(String, String, String)>) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, v) in map {
                let dotted = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{}.{}", prefix, key)
                };
                flatten(lang, &dotted, v, out);
            }
        }
        serde_json::Value::String(s) => {
            out.push((lang.to_string(), prefix.to_string(), s.clone()));
        }
        _ => {
            // 数组 / 数字 / 布尔 / null：非字符串叶子，跳过
        }
    }
}

/// 转义 Rust 字符串字面量中的 `\` 与 `"`（非 ASCII 保留 UTF-8 原样）
fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            _ => out.push(ch),
        }
    }
    out
}