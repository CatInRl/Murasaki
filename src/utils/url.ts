/**
 * URL 判定工具（前端共用）
 *
 * 链接（预览 / WYSIWYG）与图片 src 对「外部 URL」的判定必须一致，
 * 否则同一个 `mailto:` 在预览里走系统浏览器、在图片里被当成相对路径。
 */
export function isExternalUrl(url: string): boolean {
  return /^(https?:|ftp:|file:|mailto:|tel:)/i.test(url);
}
