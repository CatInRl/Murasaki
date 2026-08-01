use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use crate::i18n;

/// 最近打开菜单状态
/// - folders/files: 前端推送的最近路径列表
/// - id_to_path: 菜单项 ID → 完整路径的反查映射（每次重建菜单时刷新）
/// - current_theme: 当前选中的主题菜单项 ID（如 "theme-murasaki"），
///   供 build_app_menu 在菜单重建时恢复正确的 checked 状态
/// - current_language: 当前界面语言（"zh-CN" / "en"），供 build_app_menu
///   在菜单重建时使用对应语言的文案
///
/// 使用稳定的 ID（基于路径类型前缀 + 序号）配合 id_to_path 映射反查，
/// 避免在菜单重建期间用户点击旧菜单项时因索引错位打开错误路径。
pub struct RecentMenuState {
    pub folders: Mutex<Vec<String>>,
    pub files: Mutex<Vec<String>>,
    pub id_to_path: Mutex<HashMap<String, String>>,
    pub current_theme: Mutex<String>,
    pub current_language: Mutex<String>,
}

impl Default for RecentMenuState {
    fn default() -> Self {
        Self {
            folders: Mutex::new(Vec::new()),
            files: Mutex::new(Vec::new()),
            id_to_path: Mutex::new(HashMap::new()),
            current_theme: Mutex::new("theme-murasaki".to_string()),
            current_language: Mutex::new(i18n::DEFAULT_LANG.to_string()),
        }
    }
}

/// 构建应用主菜单
/// 在 setup 与 update_recent_menu 时共用，保证菜单结构一致
pub fn build_app_menu(app: &AppHandle) -> Result<tauri::menu::Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let state = app.state::<RecentMenuState>();
    let folders = state.folders.lock().map_err(|e| e.to_string())?.clone();
    let files = state.files.lock().map_err(|e| e.to_string())?.clone();
    let lang = state
        .current_language
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let t = i18n::menu_texts(&lang);

    // === File menu ===
    let mut file_builder = SubmenuBuilder::new(app, t.file_menu)
        .text("new-file", i18n::with_accel(t.file_new, "Ctrl+N"))
        .text("new-folder", t.file_new_folder)
        .separator()
        .text("open-file", i18n::with_accel(t.file_open_file, "Ctrl+O"))
        .text("open-folder", i18n::with_accel(t.file_open_folder, "Ctrl+Shift+O"))
        .separator();

    // "最近打开" 双子菜单：最近文件夹 + 最近文件
    // build_recent_submenu 会更新 id_to_path 映射
    let recent_folders_submenu = build_recent_submenu(app, t.recent_folders, t.no_recent, &folders, "recent-folder", &state.id_to_path)?;
    let recent_files_submenu = build_recent_submenu(app, t.recent_files, t.no_recent, &files, "recent-file", &state.id_to_path)?;
    file_builder = file_builder
        .item(&recent_folders_submenu)
        .item(&recent_files_submenu)
        .separator()
        .text("save", i18n::with_accel(t.file_save, "Ctrl+S"))
        .text("save-as", i18n::with_accel(t.file_save_as, "Ctrl+Shift+S"))
        .separator()
        .text("export-html", t.file_export_html)
        .text("export-pdf", t.file_export_pdf)
        .text("copy-rich-text", t.file_copy_rich_text)
        .separator()
        .text("close-tab", i18n::with_accel(t.file_close_tab, "Ctrl+W"))
        .text("reload-file", i18n::with_accel(t.file_reload_file, "Ctrl+R"))
        .text("close-workspace", t.file_close_workspace)
        .separator()
        .text("settings", t.file_settings)
        .separator()
        .text("quit", i18n::with_accel(t.file_quit, "Ctrl+Q"));

    let file_menu = file_builder.build()?;

    // === Edit menu ===
    let edit_menu = SubmenuBuilder::new(app, t.edit_menu)
        .text("undo", i18n::with_accel(t.edit_undo, "Ctrl+Z"))
        .text("redo", i18n::with_accel(t.edit_redo, "Ctrl+Y"))
        .separator()
        .text("cut", i18n::with_accel(t.edit_cut, "Ctrl+X"))
        .text("copy", i18n::with_accel(t.edit_copy, "Ctrl+C"))
        .text("paste", i18n::with_accel(t.edit_paste, "Ctrl+V"))
        .text("select-all", i18n::with_accel(t.edit_select_all, "Ctrl+A"))
        .separator()
        .text("find", i18n::with_accel(t.edit_find, "Ctrl+F"))
        .text("replace", i18n::with_accel(t.edit_replace, "Ctrl+H"))
        .text("find-in-files", i18n::with_accel(t.edit_find_in_files, "Ctrl+Shift+F"))
        .build()?;

    // === Paragraph menu ===
    let paragraph_menu = SubmenuBuilder::new(app, t.paragraph_menu)
        .text("heading-1", i18n::with_accel(t.para_heading1, "Ctrl+1"))
        .text("heading-2", i18n::with_accel(t.para_heading2, "Ctrl+2"))
        .text("heading-3", i18n::with_accel(t.para_heading3, "Ctrl+3"))
        .text("heading-4", i18n::with_accel(t.para_heading4, "Ctrl+4"))
        .text("heading-5", i18n::with_accel(t.para_heading5, "Ctrl+5"))
        .text("heading-6", i18n::with_accel(t.para_heading6, "Ctrl+6"))
        .text("normal", i18n::with_accel(t.para_normal, "Ctrl+0"))
        .separator()
        .text("code-block", i18n::with_accel(t.para_code_block, "Ctrl+Shift+K"))
        .text("blockquote", i18n::with_accel(t.para_blockquote, "Ctrl+Shift+Q"))
        .text("unordered-list", i18n::with_accel(t.para_unordered_list, "Ctrl+Shift+]"))
        .text("ordered-list", i18n::with_accel(t.para_ordered_list, "Ctrl+Shift+["))
        .text("task-list", i18n::with_accel(t.para_task_list, "Ctrl+Shift+X"))
        .separator()
        .text("horizontal-rule", t.para_horizontal_rule)
        .text("insert-table", t.para_insert_table)
        .build()?;

    // === Theme menu ===
    // 使用 CheckMenuItem 以支持勾选状态，checked 由 current_theme 决定
    // 菜单重建（如 update_recent_menu）时据此恢复正确的勾选项
    let current_theme = state
        .current_theme
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let theme_murasaki = CheckMenuItemBuilder::new("Murasaki")
        .id("theme-murasaki")
        .checked(current_theme == "theme-murasaki")
        .build(app)?;
    let theme_github = CheckMenuItemBuilder::new("GitHub")
        .id("theme-github")
        .checked(current_theme == "theme-github")
        .build(app)?;
    let theme_newsprint = CheckMenuItemBuilder::new("Newsprint")
        .id("theme-newsprint")
        .checked(current_theme == "theme-newsprint")
        .build(app)?;
    let theme_night = CheckMenuItemBuilder::new("Night")
        .id("theme-night")
        .checked(current_theme == "theme-night")
        .build(app)?;
    let theme_academic = CheckMenuItemBuilder::new("Academic")
        .id("theme-academic")
        .checked(current_theme == "theme-academic")
        .build(app)?;

    let theme_menu = SubmenuBuilder::new(app, t.theme_menu)
        .item(&theme_murasaki)
        .item(&theme_github)
        .item(&theme_newsprint)
        .item(&theme_night)
        .item(&theme_academic)
        .build()?;

    // === Help menu ===
    let help_menu = SubmenuBuilder::new(app, t.help_menu)
        .text("docs", t.help_docs)
        .text("about", t.help_about)
        .text("check-updates", t.help_check_updates)
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&paragraph_menu)
        .item(&theme_menu)
        .item(&help_menu)
        .build()?;

    Ok(menu)
}

/// 构建 "最近文件夹" / "最近文件" 子菜单
/// 菜单项 ID 为 `<prefix>:<idx>`，同时将映射写入 id_to_path
/// 反查时通过 ID 查 HashMap 而非索引数组，避免菜单重建期间的索引错位
fn build_recent_submenu(
    app: &AppHandle,
    title: &str,
    no_recent_label: &str,
    entries: &[String],
    prefix: &str,
    id_to_path: &Mutex<HashMap<String, String>>,
) -> Result<tauri::menu::Submenu<tauri::Wry>, Box<dyn std::error::Error>> {
    let mut builder = SubmenuBuilder::new(app, title);

    if entries.is_empty() {
        // 无条目时显示禁用的占位
        let placeholder = MenuItemBuilder::new(no_recent_label)
            .id(format!("{}:-1", prefix))
            .enabled(false)
            .build(app)?;
        builder = builder.item(&placeholder);
    } else {
        // 重建 id_to_path 中本 prefix 的映射
        let mut map = id_to_path.lock().map_err(|e| e.to_string())?;
        // 清除同前缀旧条目
        let prefix_with_colon = format!("{}:", prefix);
        map.retain(|k, _| !k.starts_with(&prefix_with_colon));
        // 写入新条目
        for (idx, path) in entries.iter().enumerate() {
            let id = format!("{}:{}", prefix, idx);
            map.insert(id.clone(), path.clone());
            // 菜单项标题显示路径的 basename
            let label = path_label(path);
            let item = MenuItemBuilder::new(label)
                .id(id)
                .build(app)?;
            builder = builder.item(&item);
        }
    }

    Ok(builder.build()?)
}

/// 从路径提取简短标签（basename），失败时返回原路径
fn path_label(path: &str) -> String {
    let p = std::path::Path::new(path);
    p.file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| path.to_string())
}

/// 前端调用：更新最近打开菜单
/// 推送最近文件夹与文件路径列表，重建主菜单
#[tauri::command]
pub fn update_recent_menu(
    app: AppHandle,
    state: tauri::State<'_, RecentMenuState>,
    folders: Vec<String>,
    files: Vec<String>,
) -> Result<(), String> {
    // 后端兜底长度校验：即使前端传入大数组也限制为 20
    const MAX_RECENT_PER_KIND: usize = 20;
    let folders: Vec<String> = folders.into_iter().take(MAX_RECENT_PER_KIND).collect();
    let files: Vec<String> = files.into_iter().take(MAX_RECENT_PER_KIND).collect();

    {
        // 先获取两把锁再修改，避免锁中毒时 folders 已更新但 files 未更新
        let mut f = state.folders.lock().map_err(|e| e.to_string())?;
        let mut fi = state.files.lock().map_err(|e| e.to_string())?;
        *f = folders;
        *fi = files;
    }
    let menu = build_app_menu(&app).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

/// 前端调用：设置主题菜单的 checked 状态
/// 同时更新 current_theme，以便后续菜单重建（如 update_recent_menu）时恢复正确勾选
#[tauri::command]
pub fn set_theme_checked(
    app: AppHandle,
    state: tauri::State<'_, RecentMenuState>,
    theme_id: String,
) -> Result<(), String> {
    // 先更新存储的主题 ID，供下次 build_app_menu 使用
    {
        let mut current = state.current_theme.lock().map_err(|e| e.to_string())?;
        *current = theme_id.clone();
    }

    // 遍历顶层菜单找到 "主题" 子菜单，更新其中各 CheckMenuItem 的勾选状态
    let theme_ids = [
        "theme-murasaki",
        "theme-github",
        "theme-newsprint",
        "theme-night",
        "theme-academic",
    ];
    let menu = app.menu().ok_or("菜单未初始化")?;
    for item in menu.items().map_err(|e| e.to_string())? {
        if let Some(submenu) = item.as_submenu() {
            for sub_item in submenu.items().map_err(|e| e.to_string())? {
                let id = sub_item.id().as_ref();
                if theme_ids.contains(&id) {
                    if let Some(check_item) = sub_item.as_check_menuitem() {
                        check_item
                            .set_checked(id == theme_id)
                            .map_err(|e| e.to_string())?;
                    }
                }
            }
        }
    }
    Ok(())
}

/// 前端调用：切换界面语言后重建原生菜单
/// 更新 current_language 并重建菜单，使菜单文案即时跟随语言切换（ADR-0013）
#[tauri::command]
pub fn reload_menu(
    app: AppHandle,
    state: tauri::State<'_, RecentMenuState>,
    lang: String,
) -> Result<(), String> {
    {
        let mut current = state.current_language.lock().map_err(|e| e.to_string())?;
        *current = lang;
    }
    let menu = build_app_menu(&app).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

/// 最近打开条目的类型
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecentKind {
    Folder,
    File,
}

impl RecentKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            RecentKind::Folder => "folder",
            RecentKind::File => "file",
        }
    }
}

/// 菜单事件处理：通过 ID 在 id_to_path 映射中反查路径
/// 返回 (path, kind)，供调用方 emit 给前端
/// 使用 HashMap 反查而非索引数组，避免菜单重建期间点击旧菜单项的索引错位
pub fn resolve_recent_entry(app: &AppHandle, menu_id: &str) -> Option<(String, RecentKind)> {
    let state = app.state::<RecentMenuState>();
    let map = state.id_to_path.lock().ok()?;
    let path = map.get(menu_id)?.clone();
    let kind = if menu_id.starts_with("recent-folder:") {
        RecentKind::Folder
    } else {
        RecentKind::File
    };
    Some((path, kind))
}
