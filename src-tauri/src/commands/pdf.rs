//! PDF 导出命令：通过 WebView2 PrintToPdf 静默导出（ADR-0010）。
//!
//! 复用前端 `exportHtml()` 产出的完整 HTML 字串，在 Rust 侧创建隐藏 webview
//! 加载该 HTML，然后调用 WebView2 `ICoreWebView2_7::PrintToPdf` 输出到指定路径。
//! 默认 A4 + 1 英寸标准边距，不暴露设置项。
//!
//! 仅 Windows 实现；macOS/Linux 留后续版本降级为 `window.print()`。

use std::sync::mpsc;
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

/// PDF 导出命令（Tauri command）。
///
/// 前端通过 `invoke("export_pdf", { html, outputPath })` 调用。
/// 接收完整 HTML 字串 + 输出路径，驱动 WebView2 PrintToPdf 静默导出。
#[tauri::command]
pub async fn export_pdf(
    app: AppHandle,
    html: String,
    output_path: String,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        export_pdf_windows(&app, html, output_path).await
    }
    #[cfg(not(windows))]
    {
        let _ = (app, html, output_path);
        Err("PDF 导出目前仅支持 Windows（macOS/Linux 降级路径留后续版本）".to_string())
    }
}

#[cfg(windows)]
async fn export_pdf_windows(
    app: &AppHandle,
    html: String,
    output_path: String,
) -> Result<(), String> {
    // 创建隐藏 webview（唯一标签，避免冲突）
    let label = format!("pdf-export-{}", uuid::Uuid::new_v4());
    let webview = WebviewWindowBuilder::new(app, &label, WebviewUrl::default())
        .visible(false)
        .inner_size(800.0, 600.0)
        .build()
        .map_err(|e| format!("创建隐藏 webview 失败: {}", e))?;

    // 通过 channel 接收 with_webview 闭包的结果
    // with_webview 将闭包派发到 UI 线程执行并阻塞当前线程直到完成
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let html_clone = html.clone();
    let output_path_clone = output_path.clone();

    let dispatch_result = webview.with_webview(move |pw| {
        let result = print_to_pdf_inner(pw, &html_clone, &output_path_clone);
        let _ = tx.send(result);
    });

    if let Err(e) = dispatch_result {
        let _ = webview.close();
        return Err(format!("with_webview 调度失败: {}", e));
    }

    let result = rx.recv().map_err(|e| format!("接收导出结果失败: {}", e))?;

    // 销毁隐藏 webview（无论成功或失败，避免内存泄漏）
    let _ = webview.close();

    result
}

/// 在 `with_webview` 闭包内执行 PrintToPdf。
///
/// 此函数运行在 UI 线程上，使用 `wait_with_pump` 泵送 Windows 消息
/// 以保持 UI 响应同时等待 WebView2 异步回调。
#[cfg(windows)]
fn print_to_pdf_inner(
    pw: tauri::webview::PlatformWebview,
    html: &str,
    output_path: &str,
) -> Result<(), String> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::*,
        wait_with_pump, NavigationCompletedEventHandler, PrintToPdfCompletedHandler,
    };
    use windows::core::{HSTRING, Interface};

    let controller = pw.controller();
    let core = unsafe { controller.CoreWebView2() }
        .map_err(|e| format!("获取 CoreWebView2 失败: {}", e))?;

    // 1. 注册 NavigationCompleted 事件处理器
    //    必须在 NavigateToString 之前注册，避免错过事件
    //    事件通过 Windows 消息循环派发，在 wait_with_pump 泵送时触发
    let (nav_tx, nav_rx) = mpsc::channel::<Result<(), String>>();
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
                let _ = nav_tx.send(Err("页面导航失败".to_string()));
            }
            Ok(())
        },
    ));
    let mut nav_token: i64 = 0;
    unsafe { core.add_NavigationCompleted(&nav_handler, &mut nav_token) }
        .map_err(|e| format!("注册 NavigationCompleted 失败: {}", e))?;

    // 2. 加载 HTML（NavigateToString 接受原始 HTML 字串）
    let html_hstring = HSTRING::from(html);
    unsafe { core.NavigateToString(&html_hstring) }
        .map_err(|e| format!("NavigateToString 失败: {}", e))?;

    // 3. 等待导航完成（wait_with_pump 泵送消息，UI 保持响应）
    let nav_result = wait_with_pump(nav_rx)
        .map_err(|e| format!("等待导航完成超时: {:?}", e))?;
    nav_result?;

    // 4. 创建打印设置（A4 + 1 英寸标准边距）
    //    CreatePrintSettings 在 ICoreWebView2Environment6 接口上
    let env = pw.environment();
    let env6: ICoreWebView2Environment6 = env
        .cast()
        .map_err(|e| format!("获取 ICoreWebView2Environment6 失败: {}", e))?;
    let settings = unsafe { env6.CreatePrintSettings() }
        .map_err(|e| format!("CreatePrintSettings 失败: {}", e))?;

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
        .map_err(|e| format!("获取 ICoreWebView2_7 失败: {}", e))?;

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
        .map_err(|e| format!("PrintToPdf 调用失败: {}", e))?;

    let (result, is_success) = wait_with_pump(pdf_rx)
        .map_err(|e| format!("等待 PrintToPdf 完成超时: {:?}", e))?;

    result.map_err(|e| format!("PrintToPdf 完成但有错误: {}", e))?;

    if !is_success {
        return Err("PrintToPdf 报告失败（isSuccess=false）".to_string());
    }

    Ok(())
}
