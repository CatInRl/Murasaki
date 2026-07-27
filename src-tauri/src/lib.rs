pub mod commands;

use tauri::{Emitter, Manager, WebviewWindowBuilder};
use commands::agent_files;
use commands::ai_providers;
use commands::assets;
use commands::chats;
use commands::drafts;
use commands::files;
use commands::menu::{self, RecentMenuState};
use commands::outline;
use commands::watcher::{self, WatcherState};

/// 检测命令行参数中是否包含 `--remote-debugging-port=PORT`，如有则返回
/// 用于转发给 WebView2 的 additional_browser_args 字符串
///
/// 这是为了支持 tauri-driver + msedgedriver 的 E2E 测试：
/// msedgedriver 启动 murasaki.exe 时会附加 `--remote-debugging-port=PORT --user-data-dir=PATH`
/// 但 wry 默认不会把这些参数转发给 WebView2，导致 msedgedriver 无法连接 CDP
fn detect_remote_debugging_args() -> Option<String> {
    // 记录所有接收到的命令行参数到文件，便于调试 msedgedriver 的启动行为
    let args_log = std::env::args().collect::<Vec<_>>().join("\n");
    let log_path = std::env::var("LOCALAPPDATA")
        .map(|p| std::path::PathBuf::from(p).join("com.murasaki.app").join("murasaki-args.log"))
        .ok();
    if let Some(lp) = log_path {
        let _ = std::fs::create_dir_all(lp.parent().unwrap_or(std::path::Path::new(".")));
        let _ = std::fs::write(&lp, &args_log);
        eprintln!("[murasaki] args dumped to {}", lp.display());
    }
    eprintln!("[murasaki] received {} args:", std::env::args().count());
    for (i, arg) in std::env::args().enumerate() {
        eprintln!("[murasaki]   [{}] = {}", i, arg);
    }

    let mut args = std::env::args().skip(1);
    let mut port: Option<String> = None;
    while let Some(arg) = args.next() {
        if let Some(p) = arg.strip_prefix("--remote-debugging-port=") {
            port = Some(p.to_string());
        }
    }
    let port = port?;
    // wry 默认会注入 --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection
    // 我们设置 additional_browser_args 时需手动保留这些默认禁用项
    Some(format!(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={}",
        port
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 单实例回调：第二个实例启动时，聚焦现有窗口
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            // 若 argv 携带工作区路径（非 --flag 参数），通知前端打开该工作区
            // argv[0] 是 exe 路径，argv[1] 可能是用户拖入或命令行传入的工作区路径
            if let Some(arg) = argv.get(1) {
                if !arg.starts_with("--") && !arg.is_empty() {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit("single-instance-open-workspace", arg.clone());
                    }
                }
            }
        }))
        .manage(WatcherState::default())
        .manage(RecentMenuState::default())
        .invoke_handler(tauri::generate_handler![
            files::list_tree,
            files::create_file,
            files::create_directory,
            files::delete_path,
            files::rename_path,
            files::copy_file,
            files::read_text_file,
            files::read_binary_file,
            files::write_text_file,
            files::path_exists,
            files::path_type,
            files::reveal_in_explorer,
            outline::parse_outline,
            outline::invalidate_outline_cache,
            outline::clear_outline_cache,
            drafts::save_draft,
            drafts::read_draft,
            drafts::delete_draft,
            drafts::draft_exists,
            drafts::get_app_data_dir,
            drafts::get_file_mtime,
            assets::save_image_asset,
            assets::copy_image_to_assets,
            watcher::start_watching,
            watcher::stop_watching,
            watcher::stop_all_watching,
            menu::update_recent_menu,
            ai_providers::get_ai_providers,
            ai_providers::save_ai_provider,
            ai_providers::delete_ai_provider,
            ai_providers::set_active_provider,
            ai_providers::get_api_key,
            ai_providers::test_provider_connection,
            agent_files::agent_list_files,
            agent_files::agent_read_file,
            agent_files::agent_search_files,
            agent_files::agent_write_file,
            chats::save_chat,
            chats::load_chat,
            chats::delete_chat,
            chats::list_chats,
            chats::check_orphan_chats,
            chats::cleanup_orphan_chats,
        ])
        .setup(|app| {
            // 手动创建主窗口（tauri.conf.json 中 windows 数组为空）
            // 这样可以根据命令行参数动态注入 WebView2 additional_browser_args
            // 以支持 tauri-driver E2E 测试
            let mut builder = WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                .title("Murasaki")
                .inner_size(1200.0, 800.0)
                .min_inner_size(800.0, 600.0)
                .resizable(true)
                .fullscreen(false);

            if let Some(extra_args) = detect_remote_debugging_args() {
                eprintln!("[murasaki] 检测到 --remote-debugging-port，注入 WebView2 args: {}", extra_args);
                builder = builder.additional_browser_args(&extra_args);
            }

            builder.build()?;

            // Build the native menu (initial state: empty recent lists)
            let handle = app.handle();
            let menu = menu::build_app_menu(handle).map_err(|e| {
                eprintln!("Failed to build menu: {}", e);
                e.to_string()
            })?;
            app.set_menu(menu)?;

            Ok(())
        })
        .on_menu_event(|app, event| {
            let menu_id = event.id().as_ref();

            // 优先处理 "最近打开" 子菜单条目
            // 直接携带类型，避免前端反查 recentEntries 时遇到竞态
            if let Some((path, kind)) = menu::resolve_recent_entry(app, menu_id) {
                if let Some(win) = app.get_webview_window("main") {
                    let payload = serde_json::json!({
                        "path": path,
                        "type": kind.as_str(),
                    });
                    let _ = win.emit("recent-open", payload);
                }
                return;
            }

            // 其他菜单事件：透传给前端
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.emit("menu-event", menu_id);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Murasaki");
}
