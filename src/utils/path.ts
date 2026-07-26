/**
 * 路径工具函数（前端共用）
 *
 * 统一处理 Windows/Unix 路径分隔符差异，避免在每个组件中重复实现。
 * 所有函数都不访问文件系统，仅做字符串操作。
 */

/**
 * 将路径中的反斜杠（Windows）转为正斜杠（Unix）
 * 不去除末尾分隔符
 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * 去除路径末尾的分隔符（/ 或 \）
 */
export function stripTrailingSep(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

/**
 * 获取路径的最后一部分（文件名或目录名）
 * 例如：basename("C:\\docs\\file.md") → "file.md"
 */
export function basename(path: string): string {
  const parts = normalizePath(path).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * 获取路径的父目录
 * 例如：dirname("C:\\docs\\sub\\file.md") → "C:/docs/sub"
 *      dirname("/home/user/file.md") → "/home/user"
 */
export function dirname(path: string): string {
  const norm = normalizePath(path);
  // 保留 Unix 根前缀
  const leadingSlash = norm.startsWith("/") ? "/" : "";
  const parts = norm.split("/").filter(Boolean);
  parts.pop();
  return parts.length > 0 ? leadingSlash + parts.join("/") : path;
}

/**
 * 拼接多个路径段
 * 自动处理斜杠：内部使用正斜杠
 * 例如：joinPaths("C:/docs", "sub", "file.md") → "C:/docs/sub/file.md"
 */
export function joinPaths(...parts: string[]): string {
  const normalized = parts.map((p) => normalizePath(p).replace(/^\/+|\/+$/g, ""));
  return normalized.filter(Boolean).join("/");
}

/**
 * 获取文件扩展名（小写，不含点）
 * 例如：extname("file.MD") → "md"
 * 无扩展名返回空字符串
 */
export function extname(path: string): string {
  const name = basename(path);
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx === name.length - 1) return "";
  return name.slice(dotIdx + 1).toLowerCase();
}

/**
 * 解析相对路径为绝对路径
 * - 绝对路径直接返回（已规范化）
 * - 相对路径以 base 为基准解析
 *
 * @param base 基准目录（绝对路径）
 * @param relative 相对路径（如 "../images/a.png"）
 */
export function resolveRelative(base: string, relative: string): string {
  const normalizedRel = normalizePath(relative);
  // 绝对路径（Windows 盘符或 Unix /）
  if (/^([a-zA-Z]:)?\//.test(normalizedRel)) {
    return normalizedRel;
  }
  const baseParts = normalizePath(base).split("/").filter(Boolean);
  const relParts = normalizedRel.split("/").filter(Boolean);
  for (const part of relParts) {
    if (part === ".") continue;
    if (part === "..") {
      baseParts.pop();
    } else {
      baseParts.push(part);
    }
  }
  // 保留 Windows 盘符前缀（如 C:）
  const baseNorm = normalizePath(base);
  const isWindowsDrive = /^[a-zA-Z]:/.test(baseNorm);
  const joined = baseParts.join("/");
  return isWindowsDrive && !joined.startsWith("/") && /^[a-zA-Z]:/.test(joined)
    ? joined
    : (baseNorm.startsWith("/") ? "/" : "") + joined;
}

/**
 * 计算从 fromFile 所在目录到 toPath 的相对路径
 * `from` 被视为文件路径，先取其目录作为基准
 *
 * 例如：relativePath("C:/docs/a.md", "C:/docs/b.md") → "b.md"
 *      relativePath("C:/docs/sub/a.md", "C:/docs/b.md") → "../b.md"
 *      relativePath("C:/docs/a.md", "C:/docs/sub/b.md") → "sub/b.md"
 */
export function relativePath(from: string, to: string): string {
  // from 视为文件路径：取目录部分
  const fromNorm = normalizePath(from);
  const fromParts = fromNorm.split("/").filter(Boolean);
  fromParts.pop(); // 去掉文件名
  const toParts = normalizePath(to).split("/").filter(Boolean);
  // 找到共同前缀
  let i = 0;
  while (
    i < fromParts.length &&
    i < toParts.length &&
    fromParts[i].toLowerCase() === toParts[i].toLowerCase()
  ) {
    i++;
  }
  const upCount = fromParts.length - i;
  const downParts = toParts.slice(i);
  const ups: string[] = [];
  for (let k = 0; k < upCount; k++) ups.push("..");
  const result = [...ups, ...downParts].join("/");
  return result || basename(to);
}
