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

/// 拼接标签与**给人看的**快捷键提示。`accel` 为空时仅返回标签。
///
/// accelerator 用的是 Tauri 的跨平台 token `CmdOrCtrl`（表达「macOS 上是 ⌘、
/// 其余平台是 Ctrl」）。本项目菜单项**没有注册原生 accelerator**（快捷键实际由
/// 前端的全局 keydown 处理），这段字符串纯粹是提示文本 —— 原样拼进去就会显示成
/// `CmdOrCtrl+Shift+E`（Win32 还会把 `\t` 之后的部分右对齐显示，于是它正对着
/// 用户的视线，见 issue #341）。转换口径与前端 `formatShortcutForDisplay()` 一致：
/// 只换主修饰键，其余键位与 `+` 原样保留。
pub fn with_accel(label: &str, accel: &str) -> String {
    if accel.is_empty() {
        label.to_string()
    } else {
        format!("{}\t{}", label, display_accel(accel))
    }
}

/// 主修饰键的展示写法：macOS 用 ⌘，其余平台就是 Ctrl。
fn display_accel(accel: &str) -> String {
    display_accel_on(accel, cfg!(target_os = "macos"))
}

/// `display_accel` 的平台参数化实现 —— 平台判断收在参数里，两个分支都能被单测覆盖。
fn display_accel_on(accel: &str, macos: bool) -> String {
    let main = if macos { "⌘+" } else { "Ctrl+" };
    accel.replace("CmdOrCtrl+", main)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accel_shows_ctrl_instead_of_cmdorctrl() {
        assert_eq!(display_accel_on("CmdOrCtrl+Shift+E", false), "Ctrl+Shift+E");
        assert_eq!(display_accel_on("CmdOrCtrl+S", false), "Ctrl+S");
        // 与主修饰键无关的绑定原样保留
        assert_eq!(display_accel_on("F11", false), "F11");
        assert_eq!(display_accel_on("Shift+Tab", false), "Shift+Tab");
    }

    #[test]
    fn accel_shows_command_symbol_on_macos() {
        assert_eq!(display_accel_on("CmdOrCtrl+Shift+E", true), "⌘+Shift+E");
        assert_eq!(display_accel_on("CmdOrCtrl+=", true), "⌘+=");
        assert_eq!(display_accel_on("F11", true), "F11");
    }

    #[test]
    fn empty_accel_stays_empty() {
        assert_eq!(display_accel_on("", false), "");
        assert_eq!(display_accel_on("", true), "");
    }

    #[test]
    fn with_accel_never_leaks_internal_token() {
        let label = with_accel("文件树视图", "CmdOrCtrl+Shift+E");
        assert!(!label.contains("CmdOrCtrl"));
        assert!(label.starts_with("文件树视图\t"));
    }

    #[test]
    fn with_accel_without_accel_is_plain_label() {
        assert_eq!(with_accel("状态栏", ""), "状态栏");
    }
}