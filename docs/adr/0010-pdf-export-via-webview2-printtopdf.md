# ADR 0010: PDF 导出采用 WebView2 PrintToPdf 静默导出

## 状态

已接受

## 背景

spec.md「Out of Scope」将 PDF 导出标注为「留到后续」，当前仅支持 HTML 导出（[useHtmlExport.ts](../../src/composables/useHtmlExport.ts) 的 `exportHtml()` 产出完整独立 HTML：markdown-it 渲染 + Shiki 高亮 + Base64 内联图片 + 主题 CSS）。CONTEXT.md 导出章节亦写明「PDF 导出当前不做，用户可用 HTML 在浏览器中自助打印」。

0.4.0 将 PDF 导出列为正式特性。核心问题：用哪条渲染路径把 markdown 变成 PDF。

项目是 Windows 优先（Tauri 2.x + WebView2），且已有一套高保真 HTML 导出管线（导出=预览=WYSIWYG 三端视觉一致是 0.3.0 硬约束）。PDF 导出应复用这套管线，保证「导出 PDF = 预览外观」。

## 决策

PDF 导出采用 **WebView2 PrintToPdf API 静默导出**：

1. 复用 `exportHtml()` 产出完整 HTML 字串（含主题 CSS、Base64 图片、Shiki 高亮）。
2. 将该 HTML 加载到一个隐藏的 Tauri WebviewWindow（或复用主窗口的离屏 webview）。
3. Rust 侧通过 WebView2 COM API（`webview2-com` crate 或 Tauri 暴露的 webview 句柄）调用 `PrintToPdf`，输出到用户通过「另存为」对话框选择的路径。
4. 菜单入口：「文件 → 导出 PDF…」，与「导出 HTML…」并列。

Windows 优先，高保真（与预览像素一致），静默保存（无打印对话框打扰）。macOS/Linux 后续可降级为 `window.print()` 打印对话框。

## 理由

1. **复用现有 HTML 管线，零重复渲染逻辑** —— `exportHtml()` 已保证导出=预览视觉一致，PDF 直接吃它的输出，不引入第二套 markdown→PDF 渲染路径。
2. **WebView2 是 Windows 上的原生 webview** —— Tauri 在 Windows 已用 WebView2，无需额外依赖。`PrintToPdf` 是 WebView2 的内置能力，输出保真度高（Chromium 引擎打印）。
3. **静默导出体验优于打印对话框** —— 用户点「导出 PDF…」→ 选路径 → 直接得到 PDF，无需在系统打印对话框里手动选「另存为 PDF」、调页边距。
4. **与项目「Windows 优先」定位一致** —— spec.md 明确 Windows 优先、macOS 1.0 后考虑。WebView2 PrintToPdf 在 Windows 上是最佳路径；跨平台不是 0.4.0 目标。

## 备选方案

**打印对话框（`window.print()`）** —— 在隐藏 iframe/新窗口加载导出 HTML 后触发 `window.print()`，用户在系统打印对话框选「另存为 PDF」。被否决：零 Rust 改动、跨平台，但非静默、依赖用户手动操作、页边距/页眉由浏览器控制不可控、体验割裂。可作为 macOS/Linux 的降级路径保留。

**headless_chrome crate** —— Rust 侧用 `headless_chrome` 启动无头 Edge/Chrome 打印 HTML→PDF。被否决：跨平台静默、高保真，但引入重依赖、要求机器装 Chrome/Edge 二进制、增加安装包与构建复杂度。WebView2 已内嵌于 Tauri，无需额外浏览器二进制。

**Rust PDF 库（printpdf/typst）** —— 直接在 Rust 侧把 markdown 渲染为 PDF。被否决：需自建一套与 markdown-it 不同的排版逻辑，无法保证与预览视觉一致，布局工作量大（分页、字体回退、代码高亮、Mermaid/KaTeX 等都要重做）。

## 后果

**正面**
- 导出 PDF 与预览/导出 HTML 视觉完全一致（同一 HTML 输入）。
- 静默导出，用户体验流畅。
- 不引入重依赖（WebView2 已存在）。

**负面**
- Windows 专属 API，macOS/Linux 需另写降级路径（0.4.0 不做，后续版本处理）。
- 需写 Rust 侧 WebView2 COM 调用代码（中等复杂度），或评估 Tauri 2.x 是否已暴露跨平台 `print_to_pdf`。
- 隐藏 webview 的生命周期管理需谨慎（导出完成后销毁，避免内存泄漏）。

## 实施边界

- 复用 `exportHtml()`，不新建渲染管线。
- Rust 新增 `export_pdf` 命令：接收 HTML 字串 + 输出路径，驱动 WebView2 PrintToPdf。
- 前端「导出 PDF…」菜单项调用 dialog 选路径 → invoke `export_pdf`。
- 导出选项（页边距/纸张大小）0.4.0 用合理默认值（A4 + 标准边距），不暴露设置项。
