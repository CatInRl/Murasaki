//! 原生菜单国际化（T4.1 / ADR-0013）
//!
//! Rust 端的菜单文案无法直接复用前端的 vue-i18n JSON（Tauri 启动时
//! WebView 尚未就绪），故在此维护一份与 `src/locales/{zh-CN,en}/menu.json`
//! 对齐的翻译表。
//!
//! 切换语言时前端调用 `reload_menu` 命令，传入新的 locale，本模块
//! 据此返回对应的 `MenuTexts`，由 `menu::build_app_menu` 重建原生菜单。
//!
//! 快捷键（accelerator）跨语言通用，由 `with_accel` 在调用处拼接，
//! 避免在翻译表中重复维护。

/// 应用支持的界面语言
pub const SUPPORTED_LANGS: &[&str] = &["zh-CN", "en"];

/// 默认语言（与前端 DEFAULT_SETTINGS.language 一致）
pub const DEFAULT_LANG: &str = "zh-CN";

/// 菜单文案集合（仅标签，不含快捷键）
#[derive(Clone, Copy)]
pub struct MenuTexts {
    // 顶层菜单
    pub file_menu: &'static str,
    pub edit_menu: &'static str,
    pub paragraph_menu: &'static str,
    pub theme_menu: &'static str,
    pub help_menu: &'static str,
    // 最近打开
    pub recent_folders: &'static str,
    pub recent_files: &'static str,
    pub no_recent: &'static str,
    // File 菜单
    pub file_new: &'static str,
    pub file_new_folder: &'static str,
    pub file_open_file: &'static str,
    pub file_open_folder: &'static str,
    pub file_save: &'static str,
    pub file_save_as: &'static str,
    pub file_export_html: &'static str,
    pub file_export_pdf: &'static str,
    pub file_copy_rich_text: &'static str,
    pub file_close_tab: &'static str,
    pub file_reload_file: &'static str,
    pub file_close_workspace: &'static str,
    pub file_settings: &'static str,
    pub file_quit: &'static str,
    // Edit 菜单
    pub edit_undo: &'static str,
    pub edit_redo: &'static str,
    pub edit_cut: &'static str,
    pub edit_copy: &'static str,
    pub edit_paste: &'static str,
    pub edit_select_all: &'static str,
    pub edit_find: &'static str,
    pub edit_replace: &'static str,
    pub edit_find_in_files: &'static str,
    // Paragraph 菜单
    pub para_heading1: &'static str,
    pub para_heading2: &'static str,
    pub para_heading3: &'static str,
    pub para_heading4: &'static str,
    pub para_heading5: &'static str,
    pub para_heading6: &'static str,
    pub para_normal: &'static str,
    pub para_code_block: &'static str,
    pub para_blockquote: &'static str,
    pub para_unordered_list: &'static str,
    pub para_ordered_list: &'static str,
    pub para_task_list: &'static str,
    pub para_horizontal_rule: &'static str,
    pub para_insert_table: &'static str,
    // Help 菜单
    pub help_docs: &'static str,
    pub help_about: &'static str,
    pub help_check_updates: &'static str,
}

/// 拼接标签与快捷键。`accel` 为空时仅返回标签。
pub fn with_accel(label: &str, accel: &str) -> String {
    if accel.is_empty() {
        label.to_string()
    } else {
        format!("{}\t{}", label, accel)
    }
}

/// 按语言获取菜单文案。未知语言回退到默认（zh-CN）。
pub fn menu_texts(lang: &str) -> MenuTexts {
    match lang {
        "en" => en_texts(),
        _ => zh_cn_texts(),
    }
}

fn zh_cn_texts() -> MenuTexts {
    MenuTexts {
        file_menu: "文件",
        edit_menu: "编辑",
        paragraph_menu: "段落",
        theme_menu: "主题",
        help_menu: "帮助",
        recent_folders: "最近文件夹",
        recent_files: "最近文件",
        no_recent: "（无）",
        file_new: "新建文件…",
        file_new_folder: "新建文件夹…",
        file_open_file: "打开文件…",
        file_open_folder: "打开文件夹…",
        file_save: "保存",
        file_save_as: "另存为…",
        file_export_html: "导出 HTML…",
        file_export_pdf: "导出 PDF…",
        file_copy_rich_text: "复制为富文本",
        file_close_tab: "关闭标签页",
        file_reload_file: "重新加载文件",
        file_close_workspace: "关闭工作区",
        file_settings: "设置…",
        file_quit: "退出",
        edit_undo: "撤销",
        edit_redo: "重做",
        edit_cut: "剪切",
        edit_copy: "复制",
        edit_paste: "粘贴",
        edit_select_all: "全选",
        edit_find: "查找…",
        edit_replace: "替换…",
        edit_find_in_files: "在文件中查找…",
        para_heading1: "标题 1",
        para_heading2: "标题 2",
        para_heading3: "标题 3",
        para_heading4: "标题 4",
        para_heading5: "标题 5",
        para_heading6: "标题 6",
        para_normal: "普通",
        para_code_block: "代码块",
        para_blockquote: "引用块",
        para_unordered_list: "无序列表",
        para_ordered_list: "有序列表",
        para_task_list: "任务列表",
        para_horizontal_rule: "水平分隔线",
        para_insert_table: "插入表格…",
        help_docs: "查看文档",
        help_about: "关于 Murasaki",
        help_check_updates: "检查更新…",
    }
}

fn en_texts() -> MenuTexts {
    MenuTexts {
        file_menu: "File",
        edit_menu: "Edit",
        paragraph_menu: "Paragraph",
        theme_menu: "Theme",
        help_menu: "Help",
        recent_folders: "Recent Folders",
        recent_files: "Recent Files",
        no_recent: "(None)",
        file_new: "New File…",
        file_new_folder: "New Folder…",
        file_open_file: "Open File…",
        file_open_folder: "Open Folder…",
        file_save: "Save",
        file_save_as: "Save As…",
        file_export_html: "Export HTML…",
        file_export_pdf: "Export PDF…",
        file_copy_rich_text: "Copy as Rich Text",
        file_close_tab: "Close Tab",
        file_reload_file: "Reload File",
        file_close_workspace: "Close Workspace",
        file_settings: "Settings…",
        file_quit: "Quit",
        edit_undo: "Undo",
        edit_redo: "Redo",
        edit_cut: "Cut",
        edit_copy: "Copy",
        edit_paste: "Paste",
        edit_select_all: "Select All",
        edit_find: "Find…",
        edit_replace: "Replace…",
        edit_find_in_files: "Find in Files…",
        para_heading1: "Heading 1",
        para_heading2: "Heading 2",
        para_heading3: "Heading 3",
        para_heading4: "Heading 4",
        para_heading5: "Heading 5",
        para_heading6: "Heading 6",
        para_normal: "Normal",
        para_code_block: "Code Block",
        para_blockquote: "Blockquote",
        para_unordered_list: "Bullet List",
        para_ordered_list: "Numbered List",
        para_task_list: "Task List",
        para_horizontal_rule: "Horizontal Rule",
        para_insert_table: "Insert Table…",
        help_docs: "View Documentation",
        help_about: "About Murasaki",
        help_check_updates: "Check for Updates…",
    }
}
