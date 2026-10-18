/**
 * 预览内链接的分类与解析（#435）。
 *
 * 从 PreviewPane 抽出：链接判定与 .md 相对路径解析都是纯字符串逻辑，
 * 路径口径统一走 utils/path，避免组件里再长出一套「自研路径实现」。
 */
import { dirname, extname, resolveRelative } from "./path";

const MD_EXTENSIONS = ["md", "markdown", "mdown", "mkd"];

/** 外部 URL（交给系统浏览器/默认行为处理） */
export function isExternalUrl(href: string): boolean {
  return /^(https?:|ftp:|file:|mailto:|tel:)/i.test(href);
}

/** 页内锚点（#section） */
export function isAnchorLink(href: string): boolean {
  return href.startsWith("#");
}

export interface InternalLinkContext {
  /** 当前文件路径：优先以它所在目录为基准 */
  filePath?: string | null;
  /** 工作区根路径：没有当前文件时作为基准 */
  workspacePath?: string | null;
}

/**
 * 把预览里的 .md 链接解析为绝对路径。
 *
 * - 外部 URL / 锚点 / 非 Markdown 扩展名 → null（交给调用方按原逻辑处理）
 * - 相对路径以当前文件所在目录为基准；没有当前文件时以工作区根为基准
 *
 * 已含盘符的绝对路径原样返回（不经手写拼接，避免出现 `/C:/ws/b.md`）。
 */
export function resolveInternalMarkdownLink(
  href: string,
  context: InternalLinkContext
): string | null {
  if (isExternalUrl(href) || isAnchorLink(href)) return null;

  // 去掉 URL fragment 和 query
  const cleanHref = href.split("#")[0].split("?")[0];
  if (!cleanHref) return null;
  if (!MD_EXTENSIONS.includes(extname(cleanHref))) return null;

  const baseDir = context.filePath ? dirname(context.filePath) : context.workspacePath;
  if (!baseDir) return null;
  return resolveRelative(baseDir, cleanHref);
}
