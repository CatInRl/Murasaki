/**
 * 图片路径解析（ADR-0015 / issue #118）
 *
 * Tauri WebView 中相对/绝对本地图片路径无法直接加载，需通过 `convertFileSrc()`
 * 转为 `asset://localhost/...`（Windows 为 `https://asset.localhost/...`）协议 URL。
 *
 * 支持四种图片 src 格式：
 * 1. 相对路径（`assets/photo.png`）→ 解析为绝对路径（基于当前文件目录）→ convertFileSrc
 * 2. 绝对路径（`C:\photos\image.png` / `/home/user/img.png`）→ 直接 convertFileSrc
 * 3. URL（`http(s)://` / `ftp:` / `mailto:` / `tel:`）→ 原样保留
 * 4. Base64（`data:image/...;base64,...`）→ 原样保留
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import type MarkdownIt from "markdown-it";
import { dirname, resolveRelative, normalizePath } from "./path";

/**
 * 判断 src 是否为 URL（http/https/ftp/mailto/tel/file 协议）。
 * 这些协议在 WebView 中可直接加载，无需转换。
 */
export function isExternalUrl(src: string): boolean {
  return /^(https?:|ftp:|file:|mailto:|tel:)/i.test(src);
}

/**
 * 判断 src 是否为 Base64 data URL。
 */
export function isDataUrl(src: string): boolean {
  return src.startsWith("data:");
}

/**
 * 本应用会生成的「内嵌图片」data URI 接受范围（issue #151 的 Base64 插入方式）。
 *
 * markdown-it 默认的 `validateLink` 只放行 `data:image/(gif|png|jpeg|webp)`：
 * 其它图片 data URI（如 bmp / svg+xml）会被判为非法并把 `src` 清空，预览里直接
 * 显示成字面文本。这里显式放行本应用会产出的图片 MIME。
 */
export const INLINE_IMAGE_DATA_URI_RE =
  /^data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml)(?:;charset=[^;,]+)?;base64,/i;

/** 是否为应用生成的本地内嵌图片 data URI */
export function isInlineImageDataUri(url: string): boolean {
  return INLINE_IMAGE_DATA_URI_RE.test(url);
}

/**
 * 让 markdown-it 接受上述内嵌图片 data URI（其余 URL 仍走默认校验）。
 *
 * 注意 `validateLink` 同时用于「图片 src」与「链接 href」，因此放行后 href 也会接受
 * 这些 data URI —— 预览里点击链接会交给系统浏览器打开，而浏览器本身禁止顶层
 * `data:` 导航；相比之下「内嵌图片显示不出来」是确定会发生的功能缺陷，故取此权衡。
 */
export function allowInlineImageDataUris(md: MarkdownIt): void {
  const defaultValidate = md.validateLink.bind(md);
  md.validateLink = (url: string) => defaultValidate(url) || isInlineImageDataUri(url);
}

/**
 * 判断路径是否为绝对路径（Windows 盘符或 Unix /）。
 */
export function isAbsolutePath(src: string): boolean {
  return /^([a-zA-Z]:)?[\\/]/.test(src);
}

/**
 * 解析图片 src 为 WebView 可加载的 URL。
 *
 * @param src markdown 中的原始 src（markdown-it 可能已对反斜杠做 URL 编码）
 * @param currentFilePath 当前 .md 文件的绝对路径（用于解析相对图片路径）
 *   - 若为 null/空，则相对路径无法解析，原样返回 src
 *
 * 行为：
 * - URL / Base64 → 原样返回
 * - 绝对路径 → convertFileSrc(absolutePath)
 * - 相对路径 → 基于 currentFilePath 解析为绝对路径 → convertFileSrc(absolutePath)
 *   - currentFilePath 为空时原样返回 src（无法解析）
 *
 * 注意：markdown-it 会把 Windows 绝对路径中的反斜杠 `\` URL 编码为 `%5C`
 * （`C:\path` → `C:%5Cpath`），导致 isAbsolutePath 失效。此处先 decodeURIComponent
 * 还原原始路径。URL/Base64 跳过 decode 以保留编码字符（如 %20 空格）。
 */
export function resolveImageSrc(src: string, currentFilePath: string | null): string {
  if (!src) return src;

  // URL / Base64 原样保留（不 decode，避免破坏已编码的查询参数）
  if (isExternalUrl(src) || isDataUrl(src)) {
    return src;
  }

  // 本地路径：markdown-it 会把反斜杠编码为 %5C，先 decode 还原原始路径
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    decoded = src;
  }

  // 绝对路径直接转换
  if (isAbsolutePath(decoded)) {
    const result = convertFileSrc(normalizePath(decoded));
    return result;
  }

  // 相对路径：需要 currentFilePath 作为基准
  if (!currentFilePath) {
    return src;
  }

  const baseDir = dirname(currentFilePath);
  const absolutePath = resolveRelative(baseDir, decoded);
  const result = convertFileSrc(absolutePath);
  return result;
}

/**
 * Tauri asset 协议 URL 的前缀（`convertFileSrc` 的产物）：
 * Windows 为 `http(s)://asset.localhost/`，其它平台为 `asset://localhost/`。
 * 无 `g` 标志，`.test()` 与 `.replace()` 可安全复用。
 */
const ASSET_URL_PREFIX = /^(?:asset:\/\/localhost\/|https?:\/\/asset\.localhost\/)/i;

/**
 * 判断 src 是否为 Tauri asset 协议 URL（即 `resolveImageSrc` 转换后的产物）。
 */
export function isAssetUrl(src: string): boolean {
  return ASSET_URL_PREFIX.test(src);
}

/**
 * 把 Tauri asset 协议 URL 回解为本地文件路径 —— [`resolveImageSrc`] 的逆操作。
 *
 * 渲染给 WebView 用时图片 src 会被改写成 asset 协议 URL；而导出 HTML 需要按文件
 * 路径读字节内联为 Base64，故必须先回解（issue #258）。非 asset URL 原样返回。
 *
 * 注意：`convertFileSrc` 会对整个路径做 URL 编码（`C:\a b.png` → `C%3A%5Ca%20b.png`，
 * 也见 `resolveImageSrc` 对 markdown-it `%5C` 的还原），因此这里 decode 一次还原；
 * 解码失败（含非法百分号转义）时保留原文，交由后续「读取失败则跳过」兜底。
 */
export function assetUrlToPath(src: string): string {
  if (!isAssetUrl(src)) return src;

  const stripped = src.replace(ASSET_URL_PREFIX, "");

  let decoded = stripped;
  try {
    decoded = decodeURIComponent(stripped);
  } catch {
    decoded = stripped;
  }

  return normalizePath(decoded);
}
