/**
 * T6.2 (issue #100) — Frontmatter 范围检测。
 *
 * CM6 lang-markdown 不内置 Frontmatter 语法节点，无法通过 syntaxTree 识别。
 * 本模块用纯文本扫描检测文档起始的 YAML frontmatter 块（与 markdown-it-front-matter
 * 行为一致）：起始行 `---`，闭合行独占 `---` 或 `...`。
 *
 * computeDecorations 在光标离开 frontmatter 范围时生成卡片 widget 替换原始文本，
 * 点击卡片切源码模式并定位到 frontmatter 起始行（由 SourceEditor 监听自定义事件处理）。
 */

export interface FrontmatterRange {
  /** 起始位置（始终为 0，frontmatter 必须在文档起始） */
  from: number;
  /** 结束位置（含闭合标记行的换行符，便于 widget 整体替换） */
  to: number;
  /** 去除首尾 `---`/`...` 包裹后的 YAML 文本 */
  content: string;
}

/**
 * 检测文档起始的 YAML frontmatter 范围。
 *
 * 规则：
 * - 文档第一行（trim 后）必须为 `---`
 * - 后续必须存在独占一行的 `---` 或 `...` 作为闭合标记
 * - 闭合标记行允许尾部空白，但不能有其他非空白字符
 * - 支持 LF 与 CRLF 行尾
 *
 * @param doc 完整文档文本
 * @returns 检测到 frontmatter 时返回范围与内容；否则返回 null
 */
export function findFrontmatterRange(doc: string): FrontmatterRange | null {
  // 定位第一个换行符，取出第一行
  const firstNewline = doc.indexOf("\n");
  if (firstNewline === -1) return null; // 单行文档，无 frontmatter 可能
  const firstLine = doc.slice(0, firstNewline);
  if (firstLine.trim() !== "---") return null;

  const afterStart = firstNewline + 1; // 跳过起始行的换行符
  let lineStart = afterStart;
  while (lineStart < doc.length) {
    let lineEnd = doc.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = doc.length;
    const line = doc.slice(lineStart, lineEnd);
    // 闭合标记行：trim 后为 --- 或 ...，且长度短（排除 "--- not closing" 这类行内内容）
    const trimmed = line.trim();
    if (trimmed === "---" || trimmed === "...") {
      // 找到闭合标记
      let contentEnd: number;
      if (lineStart === afterStart) {
        // 空 frontmatter（---\n---\n）：起始后立即闭合，无内容
        contentEnd = afterStart;
      } else {
        // 内容到闭合标记行的前一个换行符（不含）
        contentEnd = lineStart - 1;
        // CRLF 支持：若换行符前有 \r，排除它（避免 content 末尾残留 \r）
        if (contentEnd > afterStart && doc[contentEnd - 1] === "\r") {
          contentEnd -= 1;
        }
      }
      // 归一化 CRLF → LF，避免 content 内残留 \r 影响下游解析
      const content = doc.slice(afterStart, contentEnd).replace(/\r\n?/g, "\n");
      // to 包含闭合标记行及其换行符（若有）
      const closingLineEnd = lineEnd < doc.length ? lineEnd + 1 : doc.length;
      return { from: 0, to: closingLineEnd, content };
    }
    if (lineEnd === doc.length) break; // 已到文档末尾，无闭合标记
    lineStart = lineEnd + 1;
  }
  return null;
}
