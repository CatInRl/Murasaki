/**
 * 文件类型判定（统一入口，issue 0.x：支持非 md 文本/代码文件查看编辑）
 *
 * 集中管理三类判断，供文件树图标、编辑器模式强制、大纲可用性复用：
 * 1. 是否 Markdown 文件（md/markdown/mdown/mkd）—— 走完整预览/所见即所得/大纲
 * 2. 是否 HTML 文件（html/htm）—— 源码可编辑 + 右侧沙箱 iframe 预览（不提供大纲）
 * 3. 是否可编辑文本/代码文件 —— 源码模式 + CodeMirror 语言高亮；
 *    无后缀名一律允许尝试打开（#308：大小不再是「能不能打开」的门槛）
 *
 * 本文件只负责**判定**；各类型「怎么打开」（含打不开时的兜底出口）见
 * docs/adr/0020-file-open-strategy-and-fallbacks.md。
 */
import { extname, basename } from "./path";

/** 无后缀文件达到该大小时打开前先确认（默认 1MB）；不再是「能不能打开」的门槛 */
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

/** Markdown 扩展名清单（数组形式，供文件对话框过滤器复用） */
export const MARKDOWN_EXTENSIONS = [...MARKDOWN_EXTS];

/** 可编辑文本/代码扩展名清单（数组形式，供文件对话框过滤器复用） */
export const EDITABLE_TEXT_EXTENSIONS = [...TEXT_CODE_EXTS];

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
 * - 无后缀：**一律允许尝试**（#308）
 *
 * 「无后缀 + 大小」曾经是**拦截**条件（≥1MB 直接判定打不开），结果是最大的那些
 * 无后缀文件（构建日志、纯文本产物）反而永远点不开。而有没有更可靠的判据 ——
 * 真正的失败点在后端读取（非 UTF-8 时 `read_text_file` 报错），所以改成
 * 「先让试读发生，读不动再由打开失败路径兜底」（见 useFileActions.openFile）。
 *
 * @param name 文件名或路径
 */
export function isEditableTextFile(name: string): boolean {
  const ext = extname(name);
  return ext ? TEXT_CODE_EXTS.has(ext) : true;
}

/**
 * 是否能在应用内打开（markdown 或可编辑文本/代码）。
 *
 * 「能不能打开」的统一口径（#307/#379 复用）：打不开的文件一律走
 * 「用系统默认程序打开」兜底（见 ADR-0020 打开矩阵）。
 *
 * @param name 文件名或路径
 */
export function canOpenInApp(name: string): boolean {
  return isMarkdownFile(name) || isEditableTextFile(name);
}

/**
 * 无后缀文件是否「大到需要先确认」（≥ EXTENSIONLESS_TEXT_MAX_SIZE）。
 *
 * 只用于两处（#308）：
 * - 打开前确认：避免误点几百 MB 的文件把编辑器卡死
 * - 文件树图标分级：大而无后缀更可能是二进制，仍走通用文件图标
 *
 * 语义上**不是**「能不能打开」——能打开，只是要先问一句。
 */
export function isLargeExtensionlessFile(name: string, size?: number): boolean {
  if (extname(name)) return false;
  return typeof size === "number" && size >= EXTENSIONLESS_TEXT_MAX_SIZE;
}

/**
 * 是否文档类文件（markdown 或 html）—— 决定是否可以走预览/所见即所得/大纲。
 * 说明：html 源码可编辑并以沙箱 iframe 预览，但仍属于"文档类"以启用单独预览卡。
 */
export function isDocumentFile(name: string): boolean {
  return isMarkdownFile(name) || isHtmlFile(name);
}

/**
 * 判断是否应完全禁用预览/所见即所得/大纲（源码-only）。
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