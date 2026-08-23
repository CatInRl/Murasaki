pub mod commands;
pub mod i18n;

use tauri::{Emitter, Manager, WebviewWindowBuilder};
use commands::agent_files;
use commands::ai_providers;
use commands::assets;
use commands::chats;
use commands::drafts;
use commands::files;
use commands::locale;
use commands::menu::{self, RecentMenuState};
use commands::outline;
use commands::pdf;
use commands::search;
use commands::settings;
use commands::watcher::{self, WatcherState};

/// E2E 测试模式标志：msedgedriver 启动 murasaki.exe 时会附加 `--remote-debugging-port=PORT`
/// 检测到该参数即表示运行在 tauri-driver E2E 环境下
///
/// WebView2 Runtime 150 之后，msedgedriver 不再把 `--remote-debugging-port` 作为
/// 命令行参数传给应用，而是通过 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量注入，
/// 因此两种来源都需检测。
fn is_e2e_mode() -> bool {
    std::env::args().any(|a| a.starts_with("--remote-debugging-port="))
        || std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
            .map(|v| v.contains("--remote-debugging-port="))
            .unwrap_or(false)
}

/// 判断路径是文件还是目录（用于拖拽打开 / 命令行参数打开文件关联，issue #92 / #113）
fn classify_path(p: &std::path::Path) -> &'static str {
    if p.is_dir() {
        "folder"
    } else {
        "file"
    }
}

/// 返回首个非 `--flag` 的命令行参数（文件/文件夹路径）。
/// 用于首次启动时文件关联（双击 .md 文件）与命令行拖入打开。
fn first_non_flag_arg() -> Option<String> {
    std::env::args().skip(1).find(|a| !a.starts_with("--") && !a.is_empty())
}

/// 通知前端打开命令行传入的文件/文件夹路径（issue #92 / #113）。
/// - 文件：在 tab 中打开
/// - 文件夹：设为工作区
/// 通过 `open-from-argv` 事件透传给前端 useAppLifecycle 处理。
fn emit_open_path(app: &tauri::AppHandle, path: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let payload = serde_json::json!({
            "path": path,
            "type": classify_path(std::path::Path::new(path)),
        });
        let _ = window.emit("open-from-argv", payload);
    }
}

/// 解析 `--user-data-dir=PATH` 参数（msedgedriver 会传给 murasaki）
/// 同时兼容 WebView2 Runtime 150 的环境变量注入方式
fn parse_user_data_dir() -> Option<std::path::PathBuf> {
    for arg in std::env::args().skip(1) {
        if let Some(p) = arg.strip_prefix("--user-data-dir=") {
            let p = p.trim_matches('"');
            return Some(std::path::PathBuf::from(p));
        }
    }
    if let Ok(env_args) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        for token in env_args.split_whitespace() {
            if let Some(p) = token.strip_prefix("--user-data-dir=") {
                let p = p.trim_matches('"');
                return Some(std::path::PathBuf::from(p));
            }
        }
    }
    None
}

/// 从 argv 或 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量中提取
/// `--remote-debugging-port=PORT`，返回端口字符串
fn find_remote_debugging_port_str() -> Option<String> {
    for arg in std::env::args().skip(1) {
        if let Some(p) = arg.strip_prefix("--remote-debugging-port=") {
            return Some(p.to_string());
        }
    }
    if let Ok(env_args) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        for token in env_args.split_whitespace() {
            if let Some(p) = token.strip_prefix("--remote-debugging-port=") {
                return Some(p.to_string());
            }
        }
    }
    None
}

/// 找一个可用端口（用于替代 msedgedriver 传来的 port=0）
fn find_available_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(9222)
}

/// 重写 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量中的
/// `--remote-debugging-port=PORT`（含 `=0`），改为实际选定的端口。
///
/// 关键背景：WebView2 Runtime 150+ 的 msedgedriver 不再把调试参数作为命令行
/// 参数传给应用，而是通过 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量注入，
/// 且其中固定为 `--remote-debugging-port=0`。WebView2 读取该环境变量后会让浏览器
/// 进程在随机端口监听，导致 murasaki 代码里 `additional_browser_args` 注入的
/// 固定端口被忽略、后台 writer 轮询的端口永远连不上。
///
/// 因此必须在创建 WebView2 环境前把环境变量里的 `=0` 替换为实际端口，
/// 这样无论 WebView2 以环境变量还是 additional_browser_args 为准，端口都一致。
fn rewrite_env_debug_port(port: u16) {
    let Ok(mut env_args) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") else {
        return;
    };

    // 用正则替换 `--remote-debugging-port=<任意值>` 为固定端口
    // （不使用 regex crate，手动字符串替换）
    const PREFIX: &str = "--remote-debugging-port=";
    let mut result = String::new();
    let mut rest = env_args.as_str();
    let mut replaced = false;
    loop {
        match rest.find(PREFIX) {
            Some(idx) => {
                result.push_str(&rest[..idx + PREFIX.len()]);
                rest = &rest[idx + PREFIX.len()..];
                // 跳过端口值直到空白符
                let val_end = rest
                    .find(char::is_whitespace)
                    .unwrap_or(rest.len());
                let old_val = &rest[..val_end];
                if !replaced {
                    result.push_str(&port.to_string());
                    replaced = true;
                } else {
                    // 多余的 --remote-debugging-port 一律移除
                    result.truncate(result.len() - PREFIX.len());
                }
                rest = &rest[val_end..];
                let _ = old_val;
            }
            None => {
                result.push_str(rest);
                break;
            }
        }
    }

    env_args = result;
    if replaced {
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", env_args);
        e2e_trace(&format!(
            "已重写 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: --remote-debugging-port={}",
            port
        ));
    }
}

/// 检测命令行参数中的 `--remote-debugging-port=PORT`，返回
/// (WebView2 additional_browser_args, 实际监听端口)
///
/// 关键 workaround：msedgedriver 默认传 `--remote-debugging-port=0`（让系统选端口），
/// 但 WebView2 不会创建 DevToolsActivePort 文件告知 msedgedriver 实际端口。
/// 因此 murasaki 用一个固定端口替代 port=0，并启动后台线程创建该文件。
fn detect_remote_debugging_args() -> Option<(String, u16)> {
    let port_str = find_remote_debugging_port_str()?;

    let port: u16 = if port_str == "0" {
        let p = find_available_port();
        eprintln!("[murasaki] msedgedriver 传 port=0，改用固定端口 {}", p);
        p
    } else {
        port_str.parse().unwrap_or(9222)
    };

    // WebView2 Runtime 150+ 从环境变量读取调试参数，先重写环境变量确保端口一致
    rewrite_env_debug_port(port);

    // 仅注入 remote-debugging-port，不覆盖 wry 默认的 additional_browser_args
    // 若包含 --disable-features 会导致 WebView2 启动失败（实测无子进程）
    Some((format!("--remote-debugging-port={}", port), port))
}

/// 通过原始 TCP 发送 HTTP GET，返回响应 body（避免引入 async reqwest）
fn http_get_body(host: &str, port: u16, path: &str) -> Option<String> {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    let addr = format!("{}:{}", host, port);
    let socket_addr: std::net::SocketAddr = addr.parse().ok()?;

    let mut stream = TcpStream::connect_timeout(&socket_addr, Duration::from_secs(2)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .ok()?;

    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\n\r\n",
        path, host, port
    );
    stream.write_all(request.as_bytes()).ok()?;

    // 分块读取，避免 read_to_string 在某些情况下返回 0 字节
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break, // EOF
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => break,
            Err(_) => break,
        }
    }

    let response = String::from_utf8_lossy(&buf).into_owned();
    if response.is_empty() {
        return None;
    }

    // HTTP 响应格式：STATUS_LINE\r\nHEADERS\r\n\r\nBODY
    response.split("\r\n\r\n").nth(1).map(|s| s.to_string())
}

/// 从 CDP /json/version 响应中提取 webSocketDebuggerUrl（简易 JSON 解析）
fn extract_ws_url(json: &str) -> Option<String> {
    let key = "\"webSocketDebuggerUrl\":";
    let idx = json.find(key)?;
    let after_key = &json[idx + key.len()..];
    let after_key = after_key.trim_start();
    if !after_key.starts_with('"') {
        return None;
    }
    let after_quote = &after_key[1..];
    let end = after_quote.find('"')?;
    Some(after_quote[..end].to_string())
}

/// 将 murasaki 内部 E2E 调试信息写入 %TEMP%\murasaki-devtools.log（附加模式）
/// msedgedriver 启动的 murasaki 其 stderr 不会被 tauri-driver 转发，落盘便于诊断
fn e2e_trace(msg: &str) {
    use std::io::Write;
    let log_path = std::env::temp_dir().join("murasaki-devtools.log");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .and_then(|mut f| {
            writeln!(f, "[ts={}] {}", now, msg)
        });
    eprintln!("[murasaki] {}", msg);
}

/// 启动后台线程创建 DevToolsActivePort 文件
///
/// WebView2 不创建 DevToolsActivePort 文件（Chromium 浏览器的特性），
/// 但 msedgedriver 期望在 --user-data-dir 中找到它来获知 CDP 端口。
/// 该线程轮询 CDP /json/version 拿到 webSocketDebuggerUrl 后写入文件。
fn spawn_devtools_active_port_writer(port: u16, user_data_dir: std::path::PathBuf) {
    if user_data_dir.as_os_str().is_empty() {
        e2e_trace("无 --user-data-dir，跳过 DevToolsActivePort 创建");
        return;
    }

    std::thread::spawn(move || {
        e2e_trace(&format!(
            "DevToolsActivePort writer 启动: port={}, dir={}",
            port,
            user_data_dir.display()
        ));

        for attempt in 0..60 {
            std::thread::sleep(std::time::Duration::from_millis(500));

            let body = match http_get_body("127.0.0.1", port, "/json/version") {
                Some(b) => b,
                None => {
                    if attempt % 5 == 0 {
                        e2e_trace(&format!("CDP 未就绪，尝试 {} (port={})", attempt, port));
                    }
                    continue;
                }
            };

            e2e_trace(&format!("CDP 已响应，attempt={} body_len={}", attempt, body.len()));

            let ws_url = extract_ws_url(&body);
            if let Some(ws_url) = ws_url {
                e2e_trace(&format!("ws_url={}", ws_url));
                // ws://127.0.0.1:PORT/devtools/browser/UUID -> /devtools/browser/UUID
                let ws_path = ws_url
                    .splitn(4, '/')
                    .nth(3)
                    .map(|p| format!("/{}", p));

                if let Some(ws_path) = ws_path {
                    let file_path = user_data_dir.join("DevToolsActivePort");
                    let content = format!("{}\n{}", port, ws_path);

                    let _ = std::fs::create_dir_all(&user_data_dir);
                    match std::fs::write(&file_path, &content) {
                        Ok(_) => {
                            e2e_trace(&format!(
                                "DevToolsActivePort 已写入: {} (port={}, path={})",
                                file_path.display(),
                                port,
                                ws_path
                            ));
                            return;
                        }
                        Err(e) => {
                            e2e_trace(&format!("写入 DevToolsActivePort 失败: {}", e));
                            return;
                        }
                    }
                } else {
                    e2e_trace("ws_path 解析失败");
                }
            } else {
                e2e_trace(&format!("ws_url 解析失败，body 前 200 字符: {}", body.chars().take(200).collect::<String>()));
            }
        }

        e2e_trace("DevToolsActivePort writer 超时（30s）");
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let e2e = is_e2e_mode();
    eprintln!("[murasaki] e2e mode: {}", e2e);

    // 调试：把所有 argv 写入日志文件（仅 E2E 模式）
    if e2e {
        let log_path = std::env::temp_dir().join("murasaki-argv.log");
        let args_str = std::env::args().collect::<Vec<_>>().join("\n  ");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let content = format!(
            "[ts={}] argv:\n  {}\n  APPDATA={}\n  LOCALAPPDATA={}\n  PWD={}\n  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS={}\n",
            now,
            args_str,
            std::env::var("APPDATA").unwrap_or_default(),
            std::env::var("LOCALAPPDATA").unwrap_or_default(),
            std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default(),
            std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default()
        );
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .and_then(|mut f| std::io::Write::write_all(&mut f, content.as_bytes()));
    }

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    // 单实例锁定：生产环境启用，E2E 测试环境禁用
    // tauri-driver 通过 msedgedriver 启动 murasaki.exe 时会附加 --remote-debugging-port，
    // single-instance 插件会与 tauri-driver 的启动握手冲突导致进程立即退出
    if !e2e {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 单实例回调：第二个实例启动时，聚焦现有窗口
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            // 若 argv 携带文件/文件夹路径（非 --flag 参数），通知前端打开
            // argv[0] 是 exe 路径，argv[1] 可能是用户拖入、命令行传入、或双击 .md 文件关联传入的路径
            // 文件 → 打开为 tab；文件夹 → 设为工作区（issue #92 / #113）
            if let Some(arg) = argv.get(1) {
                if !arg.starts_with("--") && !arg.is_empty() {
                    emit_open_path(app, &arg);
                }
            }
        }));
    }

    builder
        .manage(WatcherState::default())
        .manage(search::SearchState::default())
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
            search::search_workspace,
            search::cancel_search,
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
            menu::set_theme_checked,
            menu::reload_menu,
            menu::update_shortcut_labels,
            settings::open_settings,
            locale::detect_system_locale,
            pdf::export_pdf,
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

            if let Some((extra_args, port)) = detect_remote_debugging_args() {
                e2e_trace(&format!(
                    "检测到 --remote-debugging-port，注入 WebView2 args: {} (port={})",
                    extra_args, port
                ));
                builder = builder.additional_browser_args(&extra_args);

                // 启动后台线程创建 DevToolsActivePort 文件
                // WebView2 不创建此文件，但 msedgedriver 期望在 --user-data-dir 中找到它
                let user_data_dir = parse_user_data_dir().unwrap_or_else(|| {
                    std::env::var("LOCALAPPDATA")
                        .map(|p| {
                            std::path::PathBuf::from(p)
                                .join("com.murasaki.app")
                                .join("EBWebView")
                        })
                        .unwrap_or_default()
                });
                spawn_devtools_active_port_writer(port, user_data_dir);
            }

            builder.build()?;

            // Build the native menu (initial state: empty recent lists)
            let handle = app.handle();
            let menu = menu::build_app_menu(handle).map_err(|e| {
                eprintln!("Failed to build menu: {}", e);
                e.to_string()
            })?;
            app.set_menu(menu)?;

            // 首次启动时处理命令行传入的文件/文件夹路径（文件关联 / 命令行拖入打开，issue #92 / #113）
            // 前端事件监听器在 onMounted 注册，可能尚未就绪，延迟 800ms 发射避免竞态
            if let Some(path) = first_non_flag_arg() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(800));
                    emit_open_path(&handle, &path);
                });
            }

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

            // 设置菜单：打开独立的设置窗口（Tauri 多窗口形态，见 ADR-0009）
            if menu_id == "settings" {
                if let Err(e) = settings::show_settings_window(app) {
                    eprintln!("[murasaki] 打开设置窗口失败: {}", e);
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
