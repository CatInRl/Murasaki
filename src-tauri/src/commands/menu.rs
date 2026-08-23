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
/// - shortcut_overrides: 快捷键覆盖表（commandId → accelerator），由前端
///   update_shortcut_labels 推送。菜单项右侧的快捷键提示据此与设置面板
///   中用户自定义的绑定保持一致。值为 None 表示该命令被禁用（不显示快捷键）
///
/// 使用稳定的 ID（基于路径类型前缀 + 序号）配合 id_to_path 映射反查，
/// 避免在菜单重建期间用户点击旧菜单项时因索引错位打开错误路径。
pub struct RecentMenuState {
    pub folders: Mutex<Vec<String>>,
    pub files: Mutex<Vec<String>>,
    pub id_to_path: Mutex<HashMap<String, String>>,
    pub current_theme: Mutex<String>,
    pub current_language: Mutex<String>,
    pub shortcut_overrides: Mutex<HashMap<String, Option<String>>>,
}

impl Default for RecentMenuState {
    fn default() -> Self {
        Self {
            folders: Mutex::new(Vec::new()),
            files: Mutex::new(Vec::new()),
            id_to_path: Mutex::new(HashMap::new()),
            current_theme: Mutex::new("theme-murasaki".to_string()),
            current_language: Mutex::new(i18n::DEFAULT_LANG.to_string()),
            shortcut_overrides: Mutex::new(HashMap::new()),
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
    // 按 menu.json 的实际点号 key 查询当前语言文案
    let mt = |key: &str| i18n::menu_text(&lang, key);
    let overrides = state
        .shortcut_overrides
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    // 解析菜单项的实际快捷键提示：
    // - 无覆盖 → 使用默认 accelerator
    // - Some(Some(a)) → 使用用户覆盖的 accelerator
    // - Some(None) → 该快捷键被禁用（accel 为空，菜单不显示快捷键）
    let accel = |menu_id: &str, default: &str| -> String {
        match overrides.get(menu_id) {
            Some(Some(a)) => a.clone(),
            Some(None) => String::new(),
            None => default.to_string(),
        }
    };

    // === File menu ===
    let mut file_builder = SubmenuBuilder::new(app, mt("fileMenu"))
        .text("new-file", i18n::with_accel(mt("file.newFile"), &accel("new-file", "Ctrl+N")))
        .text("new-folder", mt("file.newFolder"))
        .separator()
        .text("open-file", i18n::with_accel(mt("file.openFile"), &accel("open-file", "Ctrl+O")))
        .text("open-folder", i18n::with_accel(mt("file.openFolder"), &accel("open-folder", "Ctrl+Shift+O")))
        .separator();

    // "最近打开" 双子菜单：最近文件夹 + 最近文件
    // build_recent_submenu 会更新 id_to_path 映射
    let recent_folders_submenu = build_recent_submenu(app, mt("recentFolders"), mt("noRecent"), &folders, "recent-folder", &state.id_to_path)?;
    let recent_files_submenu = build_recent_submenu(app, mt("recentFiles"), mt("noRecent"), &files, "recent-file", &state.id_to_path)?;
    file_builder = file_builder
        .item(&recent_folders_submenu)
        .item(&recent_files_submenu)
        .separator()
        .text("save", i18n::with_accel(mt("file.save"), &accel("save", "Ctrl+S")))
        .text("save-as", i18n::with_accel(mt("file.saveAs"), &accel("save-as", "Ctrl+Shift+S")))
        .separator()
        .text("export-html", mt("file.exportHtml"))
        .text("export-pdf", mt("file.exportPdf"))
        .text("copy-rich-text", mt("file.copyRichText"))
        .separator()
        .text("close-tab", i18n::with_accel(mt("file.closeTab"), &accel("close-tab", "Ctrl+W")))
        .text("reload-file", i18n::with_accel(mt("file.reloadFile"), &accel("reload-file", "Ctrl+R")))
        .text("close-workspace", mt("file.closeWorkspace"))
        .separator()
        .text("settings", mt("file.settings"))
        .separator()
        .text("quit", i18n::with_accel(mt("file.quit"), &accel("quit", "Ctrl+Q")));

    let file_menu = file_builder.build()?;

    // === Edit menu ===
    let edit_menu = SubmenuBuilder::new(app, mt("editMenu"))
        .text("undo", i18n::with_accel(mt("edit.undo"), &accel("undo", "Ctrl+Z")))
        .text("redo", i18n::with_accel(mt("edit.redo"), &accel("redo", "Ctrl+Y")))
        .separator()
        .text("cut", i18n::with_accel(mt("edit.cut"), &accel("cut", "Ctrl+X")))
        .text("copy", i18n::with_accel(mt("edit.copy"), &accel("copy", "Ctrl+C")))
        .text("paste", i18n::with_accel(mt("edit.paste"), &accel("paste", "Ctrl+V")))
        .text("select-all", i18n::with_accel(mt("edit.selectAll"), &accel("select-all", "Ctrl+A")))
        .separator()
        .text("find", i18n::with_accel(mt("edit.find"), &accel("find", "Ctrl+F")))
        .text("replace", i18n::with_accel(mt("edit.replace"), &accel("replace", "Ctrl+H")))
        .text("find-in-files", i18n::with_accel(mt("edit.findInFiles"), &accel("find-in-files", "Ctrl+Shift+F")))
        .build()?;

    // === Paragraph menu ===
    let paragraph_menu = SubmenuBuilder::new(app, mt("paragraphMenu"))
        .text("heading-1", i18n::with_accel(mt("paragraph.heading1"), &accel("heading-1", "Ctrl+1")))
        .text("heading-2", i18n::with_accel(mt("paragraph.heading2"), &accel("heading-2", "Ctrl+2")))
        .text("heading-3", i18n::with_accel(mt("paragraph.heading3"), &accel("heading-3", "Ctrl+3")))
        .text("heading-4", i18n::with_accel(mt("paragraph.heading4"), &accel("heading-4", "Ctrl+4")))
        .text("heading-5", i18n::with_accel(mt("paragraph.heading5"), &accel("heading-5", "Ctrl+5")))
        .text("heading-6", i18n::with_accel(mt("paragraph.heading6"), &accel("heading-6", "Ctrl+6")))
        .text("normal", i18n::with_accel(mt("paragraph.normal"), &accel("normal", "Ctrl+0")))
        .separator()
        .text("code-block", i18n::with_accel(mt("paragraph.codeBlock"), &accel("code-block", "Ctrl+Shift+K")))
        .text("blockquote", i18n::with_accel(mt("paragraph.blockquote"), &accel("blockquote", "Ctrl+Shift+Q")))
        .text("unordered-list", i18n::with_accel(mt("paragraph.unorderedList"), &accel("unordered-list", "Ctrl+Shift+]")))
        .text("ordered-list", i18n::with_accel(mt("paragraph.orderedList"), &accel("ordered-list", "Ctrl+Shift+[")))
        .text("task-list", i18n::with_accel(mt("paragraph.taskList"), &accel("task-list", "Ctrl+Shift+X")))
        .separator()
        .text("horizontal-rule", mt("paragraph.horizontalRule"))
        .text("insert-table", mt("paragraph.insertTable"))
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

    let theme_menu = SubmenuBuilder::new(app, mt("themeMenu"))
        .item(&theme_murasaki)
        .item(&theme_github)
        .item(&theme_newsprint)
        .item(&theme_night)
        .item(&theme_academic)
        .build()?;

    // === Help menu ===
    let help_menu = SubmenuBuilder::new(app, mt("helpMenu"))
        .text("docs", mt("help.docs"))
        .text("about", mt("help.about"))
        .text("check-updates", mt("help.checkUpdates"))
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

/// 前端调用：同步快捷键覆盖到原生菜单
/// 覆盖表为 commandId → accelerator 字符串；值为 null 表示该命令的快捷键被禁用。
/// 更新 shortcut_overrides 并重建菜单，使菜单项右侧的快捷键提示与设置面板中
/// 用户自定义的绑定保持一致。
#[tauri::command]
pub fn update_shortcut_labels(
    app: AppHandle,
    state: tauri::State<'_, RecentMenuState>,
    overrides: HashMap<String, Option<String>>,
) -> Result<(), String> {
    {
        let mut current = state
            .shortcut_overrides
            .lock()
            .map_err(|e| e.to_string())?;
        *current = overrides;
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
