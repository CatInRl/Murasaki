import { invoke } from "@tauri-apps/api/core";
import { getMarkdownRenderer, getFrontMatter } from "./useMarkdownRenderer";
import { renderFrontMatterCard, FRONT_MATTER_CSS } from "./useFrontMatter";
import { MARKDOWN_THEMES } from "./useTheme";
import { codeToHtml } from "shiki";
import { dirname, extname, joinPaths } from "../utils/path";

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

/** 主题 CSS：与 PreviewPane.vue 的样式一致（精简版） */
function getThemeCss(theme: string): string {
  // 基础 markdown-body 样式 + 共享的 front-matter 卡片样式
  const base = `
.markdown-body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; padding: 24px 32px; }
.markdown-body h1 { font-size: 2em; margin: 0.67em 0; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
.markdown-body h2 { font-size: 1.5em; margin: 0.83em 0; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
.markdown-body h3 { font-size: 1.25em; margin: 1em 0; }
.markdown-body h4 { font-size: 1em; margin: 1em 0; }
.markdown-body h5 { font-size: 0.875em; margin: 1em 0; }
.markdown-body h6 { font-size: 0.85em; color: #6a737d; margin: 1em 0; }
.markdown-body p { margin: 0 0 16px; }
.markdown-body ul, .markdown-body ol { margin: 0 0 16px; padding-left: 2em; }
.markdown-body li { margin: 4px 0; }
.markdown-body blockquote { margin: 0 0 16px; padding: 0 1em; color: #6a737d; border-left: 0.25em solid #dfe2e5; }
.markdown-body code { font-family: Consolas, 'Courier New', monospace; font-size: 0.92em; background: rgba(175, 184, 193, 0.2); padding: 0.2em 0.4em; border-radius: 3px; }
.markdown-body pre { background: #0d1117; color: #c9d1d9; padding: 16px; border-radius: 6px; overflow: auto; margin: 0 0 16px; }
.markdown-body pre code { background: transparent; padding: 0; font-size: 0.9em; }
.markdown-body a { color: #0366d6; text-decoration: none; }
.markdown-body a:hover { text-decoration: underline; }
.markdown-body img { max-width: 100%; }
.markdown-body table { border-collapse: collapse; margin: 0 0 16px; display: block; overflow: auto; }
.markdown-body th, .markdown-body td { border: 1px solid #dfe2e5; padding: 6px 13px; }
.markdown-body th { background: #f6f8fa; font-weight: 600; }
.markdown-body hr { border: 0; border-top: 1px solid #eaecef; margin: 24px 0; }
.markdown-body .mermaid { text-align: center; margin: 16px 0; }
.markdown-body input[type="checkbox"] { margin-right: 0.5em; }
${FRONT_MATTER_CSS}
`;

  if (theme === "night") {
    return (
      base +
      `
body { background: #0d1117; }
.markdown-body { color: #c9d1d9; background: #0d1117; }
.markdown-body a { color: #58a6ff; }
.markdown-body blockquote { color: #8b949e; border-left-color: #30363d; }
.markdown-body th { background: #161b22; }
.markdown-body th, .markdown-body td { border-color: #30363d; }
.markdown-body code { background: rgba(110, 118, 129, 0.4); }
.markdown-body h6 { color: #8b949e; }
/* Night 主题的 front-matter 卡片样式已由共享 CSS 中的 .theme-night 前缀覆盖 */
.markdown-body.theme-night .front-matter-card { background: #161b22; border-color: #30363d; }
`
    );
  }
  if (theme === "newsprint") {
    return (
      base +
      `
body { background: #f5f5f0; }
.markdown-body { color: #2a2a2a; background: #f5f5f0; }
`
    );
  }
  if (theme === "academic") {
    return (
      base +
      `
body { background: #fffdf7; }
.markdown-body { color: #1a1a1a; background: #fffdf7; font-family: Georgia, "Times New Roman", serif; }
`
    );
  }
  // github (default)
  return (
    base +
    `
body { background: #fff; }
.markdown-body { color: #24292e; background: #fff; }
`
  );
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
      const bytes = await invoke<number[]>("read_binary_file", { path: absPath }).catch(
        () => null
      );
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
  shikiTheme: string
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
  const shikiTheme = resolveShikiTheme(theme);
  let highlighted = await highlightCodeBlocksInHtml(bodyHtml, shikiTheme);

  // 3. 内联图片为 Base64
  highlighted = await inlineImages(highlighted, workspacePath, filePath);

  // 4. 添加 front-matter 卡片
  const fmCard = renderFrontMatterCard(getFrontMatter());
  const finalBody = fmCard + highlighted;

  // 5. 包装完整 HTML
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
<body>
<div class="markdown-body">
${finalBody}
</div>
</body>
</html>`;

  return html;
}
