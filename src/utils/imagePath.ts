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
