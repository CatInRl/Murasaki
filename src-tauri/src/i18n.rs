//! 原生菜单国际化（T4.1 / ADR-0013）
//!
//! 菜单文案的单一来源是前端 `src/locales/<lang>/menu.json`。本模块在构建时
//! 由 `build.rs` 读取并展平生成 `menu_locales.rs`（见 `env!("OUT_DIR")`），
//! 运行时按 (语言, 点号 key) 查询文案，避免在 Rust 端再硬编码一份翻译表。
//!
//! 新增语言时只需在 `src/locales/` 下新建目录并补全 `menu.json`，Rust 端
//! 无需改动即可自动生效。
//!
//! 切换语言时前端调用 `reload_menu` 命令，传入新的 locale，本模块据此
//! 返回对应文案，由 `menu::build_app_menu` 重建原生菜单。
//!
//! 快捷键（accelerator）跨语言通用，由 `with_accel` 在调用处拼接。

// 构建时由 build.rs 从 src/locales/**/menu.json 自动生成。
// 提供 `SUPPORTED_LANGS` 与 `MENU_TEXTS`。
include!(concat!(env!("OUT_DIR"), "/menu_locales.rs"));

/// 默认语言（与前端 DEFAULT_SETTINGS.language 一致）
pub const DEFAULT_LANG: &str = "zh-CN";

/// 拼接标签与快捷键。`accel` 为空时仅返回标签。
pub fn with_accel(label: &str, accel: &str) -> String {
    if accel.is_empty() {
        label.to_string()
    } else {
        format!("{}\t{}", label, accel)
    }
}

/// 按 (语言, 点号 key) 查找菜单文案。未命中时返回 ""（调用方可选择回退）。
pub fn menu_text(lang: &str, key: &str) -> &'static str {
    for &(l, k, label) in MENU_TEXTS {
        if l == lang && k == key {
            return label;
        }
    }
    ""
}