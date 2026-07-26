use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

/// 最近打开菜单状态
/// - folders/files: 前端推送的最近路径列表
/// - id_to_path: 菜单项 ID → 完整路径的反查映射（每次重建菜单时刷新）
///
/// 使用稳定的 ID（基于路径类型前缀 + 序号）配合 id_to_path 映射反查，
/// 避免在菜单重建期间用户点击旧菜单项时因索引错位打开错误路径。
pub struct RecentMenuState {
    pub folders: Mutex<Vec<String>>,
    pub files: Mutex<Vec<String>>,
    pub id_to_path: Mutex<HashMap<String, String>>,
}

impl Default for RecentMenuState {
    fn default() -> Self {
        Self {
            folders: Mutex::new(Vec::new()),
            files: Mutex::new(Vec::new()),
            id_to_path: Mutex::new(HashMap::new()),
        }
    }
}

/// 构建应用主菜单
/// 在 setup 与 update_recent_menu 时共用，保证菜单结构一致
pub fn build_app_menu(app: &AppHandle) -> Result<tauri::menu::Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let state = app.state::<RecentMenuState>();
    let folders = state.folders.lock().map_err(|e| e.to_string())?.clone();
    let files = state.files.lock().map_err(|e| e.to_string())?.clone();

    // === File menu ===
    let mut file_builder = SubmenuBuilder::new(app, "文件")
        .text("new-file", "新建文件…\tCtrl+N")
        .text("new-folder", "新建文件夹…")
        .separator()
        .text("open-file", "打开文件…\tCtrl+O")
        .text("open-folder", "打开文件夹…\tCtrl+Shift+O")
        .separator();

    // "最近打开" 双子菜单：最近文件夹 + 最近文件
    // build_recent_submenu 会更新 id_to_path 映射
    let recent_folders_submenu = build_recent_submenu(app, "最近文件夹", &folders, "recent-folder", &state.id_to_path)?;
    let recent_files_submenu = build_recent_submenu(app, "最近文件", &files, "recent-file", &state.id_to_path)?;
    file_builder = file_builder
        .item(&recent_folders_submenu)
        .item(&recent_files_submenu)
        .separator()
        .text("save", "保存\tCtrl+S")
        .text("save-as", "另存为…\tCtrl+Shift+S")
        .separator()
        .text("export-html", "导出 HTML…")
        .separator()
        .text("close-tab", "关闭标签页\tCtrl+W")
        .text("reload-file", "重新加载文件\tCtrl+R")
        .text("close-workspace", "关闭工作区")
        .separator()
        .text("settings", "设置…")
        .separator()
        .text("quit", "退出\tCtrl+Q");

    let file_menu = file_builder.build()?;

    // === Edit menu ===
    let edit_menu = SubmenuBuilder::new(app, "编辑")
        .text("undo", "撤销\tCtrl+Z")
        .text("redo", "重做\tCtrl+Y")
        .separator()
        .text("cut", "剪切\tCtrl+X")
        .text("copy", "复制\tCtrl+C")
        .text("paste", "粘贴\tCtrl+V")
        .text("select-all", "全选\tCtrl+A")
        .separator()
        .text("find", "查找…\tCtrl+F")
        .text("replace", "替换…\tCtrl+H")
        .text("find-in-files", "在文件中查找…\tCtrl+Shift+F")
        .build()?;

    // === Paragraph menu ===
    let paragraph_menu = SubmenuBuilder::new(app, "段落")
        .text("heading-1", "标题 1\tCtrl+1")
        .text("heading-2", "标题 2\tCtrl+2")
        .text("heading-3", "标题 3\tCtrl+3")
        .text("heading-4", "标题 4\tCtrl+4")
        .text("heading-5", "标题 5\tCtrl+5")
        .text("heading-6", "标题 6\tCtrl+6")
        .text("normal", "普通\tCtrl+0")
        .separator()
        .text("code-block", "代码块\tCtrl+Shift+K")
        .text("blockquote", "引用块\tCtrl+Shift+Q")
        .text("unordered-list", "无序列表\tCtrl+Shift+]")
        .text("ordered-list", "有序列表\tCtrl+Shift+[")
        .text("task-list", "任务列表\tCtrl+Shift+X")
        .separator()
        .text("horizontal-rule", "水平分隔线")
        .text("insert-table", "插入表格…")
        .build()?;

    // === Theme menu ===
    let theme_menu = SubmenuBuilder::new(app, "主题")
        .text("theme-github", "GitHub")
        .text("theme-newsprint", "Newsprint")
        .text("theme-night", "Night")
        .text("theme-academic", "Academic")
        .build()?;

    // === Help menu ===
    let help_menu = SubmenuBuilder::new(app, "帮助")
        .text("docs", "查看文档")
        .text("about", "关于 Murasaki")
        .text("check-updates", "检查更新…")
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
    entries: &[String],
    prefix: &str,
    id_to_path: &Mutex<HashMap<String, String>>,
) -> Result<tauri::menu::Submenu<tauri::Wry>, Box<dyn std::error::Error>> {
    let mut builder = SubmenuBuilder::new(app, title);

    if entries.is_empty() {
        // 无条目时显示禁用的占位
        let placeholder = MenuItemBuilder::new("（无）")
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
