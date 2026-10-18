//! PDF 导出命令：通过 WebView2 PrintToPdf 静默导出（ADR-0010）。
//!
//! 复用前端 `exportHtml()` 产出的完整 HTML 字串，在 Rust 侧创建隐藏 webview
//! 加载该 HTML，然后调用 WebView2 `ICoreWebView2_7::PrintToPdf` 输出到指定路径。
//! 默认 A4 + 1 英寸标准边距，不暴露设置项。
//!
//! 仅 Windows 实现；macOS/Linux 留后续版本降级为 `window.print()`。

use std::sync::mpsc;
#[cfg(windows)]
use std::time::Duration;

use crate::errors::{CommandError, ErrorCode};
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

/// 等待 `with_webview` 整体返回的超时（导航 + 打印都卡住时的最后兜底）
#[cfg(windows)]
const PDF_EXPORT_TIMEOUT: Duration = Duration::from_secs(70);
/// 导航到 HTML 完成的超时
#[cfg(windows)]
const PDF_NAV_TIMEOUT: Duration = Duration::from_secs(20);
/// PrintToPdf 完成的超时
#[cfg(windows)]
const PDF_PRINT_TIMEOUT: Duration = Duration::from_secs(40);

/// PDF 导出命令（Tauri command）。
///
/// 前端通过 `invoke("export_pdf", { html, outputPath })` 调用。
/// 接收完整 HTML 字串 + 输出路径，驱动 WebView2 PrintToPdf 静默导出。
#[tauri::command]
pub async fn export_pdf(
    app: AppHandle,
    html: String,
    output_path: String,
) -> Result<(), CommandError> {
    #[cfg(windows)]
    {
        crate::security::policy().ensure_write(&output_path)?;
        export_pdf_windows(&app, html, output_path).await
    }
    #[cfg(not(windows))]
    {
        let _ = (app, html, output_path);
        Err(CommandError::new(ErrorCode::Unsupported).with_param("operation", "pdf_export"))
    }
}

#[cfg(windows)]
async fn export_pdf_windows(
    app: &AppHandle,
    html: String,
    output_path: String,
) -> Result<(), CommandError> {
    // 创建隐藏 webview（唯一标签，避免冲突）。
    // 初始 URL 用 about:blank：不需要加载完整 SPA，也就不会跑一遍前端初始化 / 持久化
    // （这些行为会干扰正在编辑的窗口与退出流程，#440）。内容随后由 NavigateToString 注入。
    let label = format!(
        "{}{}",
        super::windows::PDF_EXPORT_LABEL_PREFIX,
        uuid::Uuid::new_v4()
    );
    let blank: tauri::Url = "about:blank"
        .parse()
        .map_err(|e| CommandError::internal(format!("blank url: {e}")))?;
    let webview = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(blank))
        .visible(false)
        .inner_size(800.0, 600.0)
        .build()
        .map_err(|e| CommandError::internal(format!("create hidden webview: {e}")))?;

    // 通过 channel 接收 with_webview 闭包的结果
    // with_webview 将闭包派发到 UI 线程执行并阻塞当前线程直到完成
    let (tx, rx) = mpsc::channel::<Result<(), CommandError>>();
    let html_clone = html.clone();
    let output_path_clone = output_path.clone();

    let dispatch_result = webview.with_webview(move |pw| {
        let result = print_to_pdf_inner(pw, &html_clone, &output_path_clone);
        let _ = tx.send(result);
    });

    if let Err(e) = dispatch_result {
        // 用 destroy 而不是 close：CloseRequested 会被退出拦截器拦下，
        // 而这个隐藏窗口没有前端来响应落盘事件（#440）
        let _ = webview.destroy();
        return Err(CommandError::internal(format!("with_webview: {e}")));
    }

    // 超时也必须失败并继续走到 close()：否则隐藏窗口会永久留在那里
    let result = match rx.recv_timeout(PDF_EXPORT_TIMEOUT) {
        Ok(result) => result,
        Err(_) => Err(CommandError::new(ErrorCode::Timeout)
            .with_param("operation", "pdf_export")
            .with_param("detail", "PrintToPdf did not complete in time")),
    };

    // 销毁隐藏 webview（无论成功、失败还是超时，避免内存泄漏）。
    // destroy 直接销毁，不触发 CloseRequested —— 那会被退出拦截器拦住。
    let _ = webview.destroy();

    result
}

/// 带超时的消息泵（替代 `webview2_com::wait_with_pump`）。
///
/// WebView2 的回调通过 `PostMessage` 投递到 UI 线程队列，这里用 `PeekMessage`
/// 轮询并派发；没有消息时短暂休眠，避免忙等。超过 `timeout` 仍无结果时返回 `None`，
/// 让调用方失败返回，而不是永久卡住 UI 线程（#440）。
#[cfg(windows)]
fn wait_with_pump_timeout<T>(rx: &mpsc::Receiver<T>, timeout: Duration) -> Option<T> {
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageA, PeekMessageA, TranslateMessage, MSG, PM_REMOVE,
    };

    let deadline = std::time::Instant::now() + timeout;
    loop {
        if let Ok(value) = rx.try_recv() {
            return Some(value);
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }

        let mut msg = MSG::default();
        let has_message = unsafe { PeekMessageA(&mut msg, None, 0, 0, PM_REMOVE).as_bool() };
        if has_message {
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageA(&msg);
            }
        } else {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[cfg(windows)]
fn nav_timeout_error() -> CommandError {
    CommandError::new(ErrorCode::Timeout).with_param("detail", "navigation timeout")
}

/// 等待「一次成功的导航完成」。
///
/// `about:blank` 的初始导航可能被 `Stop()` / `NavigateToString` 取消并回报失败，
/// 这类失败要跳过；只有在超时前始终没有成功完成时才返回错误。
#[cfg(windows)]
fn wait_for_navigation(
    rx: &mpsc::Receiver<Result<(), CommandError>>,
    timeout: Duration,
) -> Result<(), CommandError> {
    let deadline = std::time::Instant::now() + timeout;
    let mut last_error = None;
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err(last_error.unwrap_or_else(nav_timeout_error));
        }
        match wait_with_pump_timeout(rx, remaining) {
            Some(Ok(())) => return Ok(()),
            // 被 Stop / NavigateToString 取消的旧导航
            Some(Err(e)) => last_error = Some(e),
            None => return Err(last_error.unwrap_or_else(nav_timeout_error)),
        }
    }
}

/// 在 `with_webview` 闭包内执行 PrintToPdf。
///
/// 此函数运行在 UI 线程上，通过 [`wait_with_pump_timeout`] 泵送 Windows 消息
/// 以保持 UI 响应同时等待 WebView2 异步回调。
#[cfg(windows)]
fn print_to_pdf_inner(
    pw: tauri::webview::PlatformWebview,
    html: &str,
    output_path: &str,
) -> Result<(), CommandError> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::*, NavigationCompletedEventHandler,
        PrintToPdfCompletedHandler,
    };
    use windows::core::{Interface, HSTRING};

    let controller = pw.controller();
    let core = unsafe { controller.CoreWebView2() }
        .map_err(|e| CommandError::internal(format!("CoreWebView2: {e}")))?;

    // 1. 注册 NavigationCompleted 事件处理器
    //    必须在 NavigateToString 之前注册，避免错过事件
    //    事件通过 Windows 消息循环派发，在 wait_with_pump 泵送时触发
    let (nav_tx, nav_rx) = mpsc::channel::<Result<(), CommandError>>();
    let nav_handler = NavigationCompletedEventHandler::create(Box::new(
        move |_sender, args: Option<ICoreWebView2NavigationCompletedEventArgs>| {
            let success = match &args {
                Some(a) => {
                    let mut val = windows::core::BOOL::default();
                    unsafe { a.IsSuccess(&mut val) }
                        .map(|_| val.as_bool())
                        .unwrap_or(false)
                }
                None => false,
            };
            if success {
                let _ = nav_tx.send(Ok(()));
            } else {
                let _ = nav_tx.send(Err(CommandError::internal("navigation failed")));
            }
            Ok(())
        },
    ));
    let mut nav_token: i64 = 0;
    unsafe { core.add_NavigationCompleted(&nav_handler, &mut nav_token) }
        .map_err(|e| CommandError::internal(format!("add NavigationCompleted: {e}")))?;

    // 2. 取消 about:blank 可能仍在进行的初始导航：
    //    它的完成事件若晚于处理器注册才到达，会被误判成「HTML 已加载」而打印空白页。
    let _ = unsafe { core.Stop() };

    // 3. 加载 HTML（NavigateToString 接受原始 HTML 字串）
    let html_hstring = HSTRING::from(html);
    unsafe { core.NavigateToString(&html_hstring) }
        .map_err(|e| CommandError::internal(format!("NavigateToString: {e}")))?;

    // 4. 等待导航完成：跳过被 Stop/NavigateToString 取消的旧导航（IsSuccess=false），
    //    只接受成功完成；超时则失败，避免永久卡住 UI 线程。
    wait_for_navigation(&nav_rx, PDF_NAV_TIMEOUT)?;

    // 5. 创建打印设置（A4 + 1 英寸标准边距）
    //    CreatePrintSettings 在 ICoreWebView2Environment6 接口上
    let env = pw.environment();
    let env6: ICoreWebView2Environment6 = env
        .cast()
        .map_err(|e| CommandError::internal(format!("ICoreWebView2Environment6: {e}")))?;
    let settings = unsafe { env6.CreatePrintSettings() }
        .map_err(|e| CommandError::internal(format!("CreatePrintSettings: {e}")))?;

    // A4 尺寸：8.27 × 11.69 英寸
    // 标准边距：1 英寸（上下左右）
    // 单位：英寸（WebView2 PrintSettings 的 PageWidth/PageHeight/Margin* 均为英寸）
    unsafe {
        let _ = settings.SetPageWidth(8.27);
        let _ = settings.SetPageHeight(11.69);
        let _ = settings.SetMarginTop(1.0);
        let _ = settings.SetMarginBottom(1.0);
        let _ = settings.SetMarginLeft(1.0);
        let _ = settings.SetMarginRight(1.0);
    }

    // 5. 获取 ICoreWebView2_7 接口（PrintToPdf 所在接口）
    let core7: ICoreWebView2_7 = core
        .cast()
        .map_err(|e| CommandError::internal(format!("ICoreWebView2_7: {e}")))?;

    // 6. 调用 PrintToPdf 并等待完成
    //    PrintToPdf 是异步操作，通过完成回调接收结果
    let (pdf_tx, pdf_rx) = mpsc::channel::<(windows::core::Result<()>, bool)>();
    let pdf_handler = PrintToPdfCompletedHandler::create(Box::new(
        move |result: windows::core::Result<()>, is_success: bool| {
            let _ = pdf_tx.send((result, is_success));
            Ok(())
        },
    ));

    let path_hstring = HSTRING::from(output_path);
    unsafe { core7.PrintToPdf(&path_hstring, &settings, &pdf_handler) }
        .map_err(|e| CommandError::internal(format!("PrintToPdf: {e}")))?;

    let (result, is_success) =
        wait_with_pump_timeout(&pdf_rx, PDF_PRINT_TIMEOUT).ok_or_else(|| {
            CommandError::new(ErrorCode::Timeout).with_param("detail", "print timeout")
        })?;

    result.map_err(|e| CommandError::internal(format!("PrintToPdf completed with error: {e}")))?;

    if !is_success {
        return Err(CommandError::internal("PrintToPdf reported failure")
            .with_param("detail", "isSuccess=false"));
    }

    Ok(())
}
