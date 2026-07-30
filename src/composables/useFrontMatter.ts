/**
 * YAML front-matter 卡片渲染（PreviewPane 与 HTML 导出共享）
 *
 * spec：YAML frontmatter 必须解析并渲染为样式化卡片：
 *   - title → 粗体标题
 *   - date → 可读日期格式
 *   - tags → 彩色徽章
 *   - 其他键值 → 普通行
 *
 * 采用轻量解析（不引入 js-yaml），覆盖常见 front-matter 用法。
 * PreviewPane 与 useHtmlExport 必须使用同一实现，避免预览/导出不一致。
 */

/** 转义 HTML 特殊字符 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 尝试将日期字符串格式化为可读形式（YYYY-MM-DD → 本地化日期）
 * 失败时返回原值
 */
export function formatDate(value: string): string {
  // ISO 日期 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm:ss
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (!match) return value;
  const [, y, m, d, hh, mm] = match;
  const date = new Date(
    parseInt(y, 10),
    parseInt(m, 10) - 1,
    parseInt(d, 10),
    hh ? parseInt(hh, 10) : 0,
    mm ? parseInt(mm, 10) : 0
  );
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * 将 YAML front-matter 文本渲染为样式化卡片 HTML
 * @param frontMatter 原始 front-matter 文本（不含 --- 包裹）
 * @returns HTML 字符串，无 front-matter 时返回空串
 */
export function renderFrontMatterCard(frontMatter: string): string {
  const trimmed = frontMatter.trim();
  if (!trimmed) return "";

  const lines = trimmed.split("\n");
  const fields: Array<{ key: string; value: string }> = [];
  let tags: string[] = [];

  for (const line of lines) {
    // 跳过空行和注释
    if (!line.trim() || line.trim().startsWith("#")) continue;
    // 简单 key: value 解析
    const match = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (key.toLowerCase() === "tags") {
      // tags 可能是 [a, b, c] 或 a, b, c
      const cleaned = value.replace(/^\[|\]$/g, "");
      tags = cleaned
        .split(",")
        .map((t) => t.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      fields.push({ key, value });
    }
  }

  if (fields.length === 0 && tags.length === 0) return "";

  const parts: string[] = ['<div class="front-matter-card">'];

  // 渲染字段
  for (const f of fields) {
    const keyLower = f.key.toLowerCase();
    if (keyLower === "title") {
      parts.push(`<div class="fm-title">${escapeHtml(f.value)}</div>`);
    } else if (keyLower === "date") {
      // 尝试格式化日期
      const formatted = formatDate(f.value);
      parts.push(
        `<div class="fm-row"><span class="fm-key">${escapeHtml(
          f.key
        )}</span><span class="fm-value fm-date">${escapeHtml(
          formatted
        )}</span></div>`
      );
    } else {
      parts.push(
        `<div class="fm-row"><span class="fm-key">${escapeHtml(
          f.key
        )}</span><span class="fm-value">${escapeHtml(
          f.value
        )}</span></div>`
      );
    }
  }

  // 渲染标签徽章
  if (tags.length > 0) {
    parts.push('<div class="fm-tags">');
    for (const tag of tags) {
      parts.push(`<span class="fm-tag">${escapeHtml(tag)}</span>`);
    }
    parts.push("</div>");
  }

  parts.push("</div>");
  return parts.join("");
}
