/**
 * 文件类型判定（统一入口，issue 0.x：支持非 md 文本/代码文件查看编辑）
 *
 * 集中管理三类判断，供文件树图标、编辑器模式强制、Agent/大纲可用性复用：
 * 1. 是否 Markdown 文件（md/markdown/mdown/mkd）—— 走完整预览/所见即所得/大纲/Agent
 * 2. 是否 HTML 文件（html/htm）—— 仅渲染预览（源码只读，不提供编辑/大纲/Agent）
 * 3. 是否可编辑文本/代码文件 —— 源码模式 + CodeMirror 语言高亮；
 *    无后缀名 && 大小 < 阈值（默认 1MB）按文本文档处理
 */
import { extname, basename } from "./path";

/** 无后缀文件按文本处理的字节阈值（默认 1MB） */
export const EXTENSIONLESS_TEXT_MAX_SIZE = 1024 * 1024;

/** Markdown 扩展名（不含点，小写） */
const MARKDOWN_EXTS = new Set(["md", "markdown", "mdown", "mkd"]);

/** HTML 扩展名（不含点，小写） */
const HTML_EXTS = new Set(["html", "htm"]);

/** 图片扩展名（不含点，小写），用于文件树图标与拖拽插入相对路径 */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

/**
 * 可编辑的常见文本/代码扩展名白名单（不含点，小写）。
 * 这些文件以源码模式打开 + CodeMirror 语言高亮。
 */
const TEXT_CODE_EXTS = new Set([
  // 通用文本 & 配置
  "txt", "log", "text", "csv", "tsv", "json", "jsonc", "ini", "cfg", "conf",
  "env", "properties", "yaml", "yml", "toml", "xml", "sql", "proto",
  // 前端
  "js", "jsx", "ts", "tsx", "css", "scss", "sass", "less", "html", "htm",
  "vue", "svelte",
  // 后端 / 脚本
  "py", "java", "c", "h", "cpp", "hpp", "cc", "cs", "go", "rs", "rb",
  "php", "swift", "kt", "kts", "scala", "lua", "pl", "r",
  "sh", "bash", "zsh", "ps1", "bat", "cmd",
  // 标记 / 数据 / 其他
  "md", "markdown", "mdown", "mkd", "rst", "tex", "graphql", "gql", "dart",
]);

/**
 * 是否 Markdown 文件
 * @param name 文件名或路径（内部调用 extname）
 */
export function isMarkdownFile(name: string): boolean {
  return MARKDOWN_EXTS.has(extname(name));
}

/**
 * 是否 HTML 文件
 */
export function isHtmlFile(name: string): boolean {
  return HTML_EXTS.has(extname(name));
}

/**
 * 是否图片文件（用于文件树图标、点击弹预览、拖入编辑器插入相对路径）
 */
export function isImageFile(name: string): boolean {
  return IMAGE_EXTS.has(extname(name));
}

/**
 * 是否可按文本/代码打开的"可编辑文本文件"：
 * - 有后缀：在 TEXT_CODE_EXTS 白名单内（或本身就是 markdown）→ 可编辑
 * - 无后缀：大小 < 阈值（默认 1MB）→ 按文本文档处理
 *
 * @param name 文件名或路径
 * @param size 文件大小（字节）；未知时可传 undefined，无后缀文件将按"不可判定"返回 false
 */
export function isEditableTextFile(name: string, size?: number): boolean {
  const ext = extname(name);
  if (ext) {
    return TEXT_CODE_EXTS.has(ext);
  }
  // 无后缀：仅在大小明确且低于阈值时按文本处理
  return typeof size === "number" && size >= 0 && size < EXTENSIONLESS_TEXT_MAX_SIZE;
}

/**
 * 是否文档类文件（markdown 或 html）—— 决定是否可以走预览/所见即所得/大纲/Agent。
 * 说明：html 仅渲染预览（源码只读），但仍属于"文档类"以启用单独预览卡。
 */
export function isDocumentFile(name: string): boolean {
  return isMarkdownFile(name) || isHtmlFile(name);
}

/**
 * 判断是否应完全禁用预览/所见即所得/大纲/Agent（源码-only）。
 * 只有 markdown 与 html 属于"文档类"（isDocumentFile）可参与预览；
 * 其他文本/代码/无后缀文件一律强制源码模式。
 */
export function isSourceOnlyFile(name: string): boolean {
  return !isMarkdownFile(name) && !isHtmlFile(name);
}

/**
 * 获取文件名（供日志/分类展示）
 */
export function fileName(name: string): string {
  return basename(name);
}