import { getMarkdownRenderer, getFrontMatter, resolveShikiThemeOption } from "./useMarkdownRenderer";
import { renderFrontMatterCard } from "./useFrontMatter";
import { MARKDOWN_THEMES } from "./useTheme";
import { codeToHtml, type ThemeRegistration } from "shiki";
import { dirname, extname, joinPaths } from "../utils/path";
import { fileSystem } from "../services/fileSystem";
import markdownContentCss from "../styles/markdown-content.css?raw";

/**
 * Murasaki 应用级 design token（--murasaki-* 变量）
 *
 * 导出 HTML 是独立文件，不在 Vue 应用内，无法从 :root 继承主题.css 中
 * 声明的 --murasaki-* 值。markdown-content.css 在多处引用了这些变量
 * （如 var(--murasaki-primary)、var(--murasaki-radius-md)），因此需要把
 * markdown-content.css 实际引用到的 --murasaki-* 值内联到导出 CSS 的 :root。
 *
 * 取值必须与 src/styles/theme.css 的 :root 块保持一致；任何主题.css 的
 * 调整都需要同步反映到这里。
 */
const MURASAKI_DESIGN_TOKENS = `
  --murasaki-primary: #9333ea;
  --murasaki-purple-50: #faf5ff;
  --murasaki-purple-200: #e9d5ff;
  --murasaki-purple-300: #d8b4fe;
  --murasaki-purple-700: #7e22ce;
  --murasaki-purple-800: #6b21a8;
  --murasaki-muted-foreground: #737373;
  --murasaki-surface-2: #f3f4f6;
  --murasaki-line: #e5e5e5;
  --murasaki-border: #e5e5e5;
  --murasaki-state-info: #2563eb;
  --murasaki-neutral-900: #171717;
  --murasaki-background: #ffffff;
  --murasaki-ink: #171717;
  --murasaki-ink-2: #525252;
  --murasaki-ink-3: #a3a3a3;
  --murasaki-radius-sm: 4px;
  --murasaki-radius-md: 8px;
  --murasaki-font-mono: "JetBrains Mono", "Fira Code", "Cascadia Code", "Consolas", monospace;
  --murasaki-font-ui: "Inter", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  --murasaki-shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.04);
  --murasaki-duration-fast: 120ms;
  --murasaki-ease: cubic-bezier(0.4, 0, 0.2, 1);
`;

/**
 * HTML 导出 composable
 *
 * spec 要求：
 * - 导出 HTML 必须嵌入图片为 Base64
 * - 使用当前主题的样式
 * - HTML 导出仅导出当前 tab
 * - HTML 模板的自定义来源复用 markdown 主题的 CSS
 *
 * 实现策略：
 * 1. 用 markdown-it 渲染源码为 HTML（含 front-matter 卡片、emoji、Mermaid 占位等）
 * 2. 用 Shiki 同步高亮代码块（与当前主题联动）
 * 3. 扫描 <img src="..."> 标签：相对工作区的本地图片读取为 Base64 data URI
 * 4. 包裹主题 CSS 为 <style> 内嵌
 * 5. 返回完整独立 HTML 字符串
 */

export interface ExportHtmlOptions {
  /** Markdown 源码 */
  source: string;
  /** 当前 Markdown 主题名（github / newsprint / night / academic） */
  theme: string;
  /** 工作区根路径（用于解析相对图片路径） */
  workspacePath: string | null;
  /** 当前 md 文件绝对路径（用于解析相对该文件的图片路径） */
  filePath: string | null;
}

/**
 * 主题 CSS：从共享样式 src/styles/markdown-content.css 读取
 *
 * 实现导出=预览（GitHub issue #86 / T3）：
 *   - markdown-content.css 的 [data-md-theme="X"] 块定义 --md-* 主题变量
 *   - .markdown-body 后代选择器定义所有 markdown 元素样式（含 front-matter 卡片）
 *   - 导出 HTML 的 body 同时带 markdown-body class 和 data-md-theme 属性，
 *     使 [data-md-theme="X"] 与 .markdown-body 选择器在同一元素上生效，
 *     主题切换通过 data-md-theme 属性驱动，与 PreviewPane 完全一致
 *   - --murasaki-* 设计 token 在导出文件内未定义，需在 :root 内联
 *   - 容器布局（padding/background/font）镜像 PreviewPane 的 .preview-pane 样式
 */
function getThemeCss(_theme: string): string {
  return `
:root {
${MURASAKI_DESIGN_TOKENS}
}
html, body {
  margin: 0;
  padding: 0;
}
body.markdown-body {
  /* 容器布局，与 PreviewPane.vue 的 .preview-pane 一致 */
  padding: 28px 36px;
  background: var(--md-bg, var(--murasaki-background));
  color: var(--md-fg, var(--murasaki-ink));
  font-family: var(--murasaki-font-ui);
  font-size: 14px;
  line-height: 1.75;
}
/* 共享 markdown 元素样式（含 front-matter 卡片，主题差异由 data-md-theme 驱动） */
${markdownContentCss}
`;
}

/** 解析 Shiki 主题名 */
function resolveShikiTheme(themeName: string): string {
  return (
    MARKDOWN_THEMES.find((t) => t.name === themeName)?.shikiTheme ?? "github-light"
  );
}

/**
 * 将相对路径图片转为 Base64 data URI
 * 仅处理本地路径（http/https/data 开头的跳过）
 */
async function inlineImages(
  html: string,
  workspacePath: string | null,
  filePath: string | null
): Promise<string> {
  // 匹配 <img src="..."> 中的 src
  const imgRegex = /<img\s+[^>]*src="([^"]+)"/g;
  const replacements: Array<{ original: string; replacement: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = imgRegex.exec(html)) !== null) {
    const src = match[1];
    // 跳过远程和已是 data URI 的图片
    if (/^(https?:|data:|file:)/i.test(src)) continue;

    // 解析为绝对路径
    let absPath: string | null = null;
    if (src.startsWith("/")) {
      // 绝对路径
      absPath = src;
    } else if (filePath) {
      // 相对当前 md 文件
      absPath = joinPaths(dirname(filePath), src);
    } else if (workspacePath) {
      // 相对工作区
      absPath = joinPaths(workspacePath, src);
    }

    if (!absPath) continue;

    try {
      // 读取文件字节并转 Base64
      const bytes = await fileSystem.readBinary(absPath).catch(() => null);
      if (!bytes) continue;
      const binary = String.fromCharCode(...bytes);
      const base64 = btoa(binary);
      // 推断 MIME 类型
      const ext = extname(absPath);
      const mime =
        {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          webp: "image/webp",
          bmp: "image/bmp",
          svg: "image/svg+xml",
        }[ext] ?? "image/png";
      const dataUri = `data:${mime};base64,${base64}`;
      replacements.push({
        original: match[0],
        replacement: match[0].replace(src, dataUri),
      });
    } catch (err) {
      console.warn(`内联图片失败: ${src}`, err);
    }
  }

  let result = html;
  for (const { original, replacement } of replacements) {
    result = result.replace(original, replacement);
  }
  return result;
}

/**
 * 同步高亮 HTML 字符串中的代码块
 * 替换 useMarkdownRenderer 的异步 highlight 步骤
 */
async function highlightCodeBlocksInHtml(
  html: string,
  shikiTheme: string | ThemeRegistration
): Promise<string> {
  // 匹配 <pre><code class="language-xxx" data-lang="xxx">...</code></pre>
  const blockRegex =
    /<pre[^>]*><code[^>]*data-lang="([^"]*)"[^>]*>([\s\S]*?)<\/code><\/pre>/g;
  const replacements: Array<{ original: string; replacement: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(html)) !== null) {
    const lang = match[1] || "text";
    // 反转义 HTML 实体（&lt; → <）
    const code = match[2]
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    try {
      const highlighted = await codeToHtml(code, { lang, theme: shikiTheme });
      replacements.push({ original: match[0], replacement: highlighted });
    } catch {
      // 未知语言：保留原始
    }
  }

  let result = html;
  for (const { original, replacement } of replacements) {
    result = result.replace(original, replacement);
  }
  return result;
}

/**
 * 导出 HTML：完整流程
 */
export async function exportHtml(options: ExportHtmlOptions): Promise<string> {
  const { source, theme, workspacePath, filePath } = options;
  const renderer = getMarkdownRenderer();
  renderer.setShikiTheme(resolveShikiTheme(theme));

  // 1. 渲染 markdown 为 HTML
  const bodyHtml = renderer.render(source);

  // 2. 高亮代码块
  const shikiTheme = resolveShikiThemeOption(resolveShikiTheme(theme));
  let highlighted = await highlightCodeBlocksInHtml(bodyHtml, shikiTheme);

  // 3. 内联图片为 Base64
  highlighted = await inlineImages(highlighted, workspacePath, filePath);

  // 4. 添加 front-matter 卡片
  const fmCard = renderFrontMatterCard(getFrontMatter());
  const finalBody = fmCard + highlighted;

  // 5. 包装完整 HTML
  // body 同时带 markdown-body class 和 data-md-theme 属性：
  //   - markdown-body 让 markdown-content.css 的 .markdown-body 后代选择器生效
  //   - data-md-theme 触发 [data-md-theme="X"] 块定义的 --md-* 主题变量
  //   - 不再需要内层 .markdown-body div 包裹（body 本身即容器）
  const css = getThemeCss(theme);
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Exported by Murasaki</title>
<style>
${css}
</style>
</head>
<body class="markdown-body" data-md-theme="${theme}">
${finalBody}
</body>
</html>`;

  return html;
}
