/**
 * WYSIWYG decoration computation — pure function (Ticket #72 / T7.1).
 *
 * 给定 markdown 文本 + 光标位置 + 语法树，计算出 WYSIWYG 所需的 decoration 描述符集合。
 * 该函数不依赖 CodeMirror Decoration 对象，返回可序列化的描述符，便于单元测试断言。
 *
 * 光标行为（ADR-0008）：
 * - 光标在当前段（空行分隔的连续非空行）→ 标记 dim（opacity:0.4 + 缩小）
 * - 光标离开当前段 → 标记 hide（display:none）；列表标记/分隔线替换为 widget
 *
 * P0 范围：行级标记（HeaderMark/EmphasisMark/CodeMark/QuoteMark/ListMark/TaskMarker）+ 分隔线/列表 bullet widget + 引用块左边框。
 * LinkMark 故意不在此处隐藏 —— 链接渲染是 T7.2（块级 widget），P0 隐藏 `[]()` 会留下 URL 残留，体验残缺。
 * 代码块（FencedCode/CodeBlock）整体不下降，其 ``` 反引号不隐藏（代码块 widget 是 T7.2）。
 */
import type { Tree } from "@lezer/common";

/** 行级语法标记节点名。命中即应用 hide/dim。 */
const INLINE_MARK_TYPES = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrikethroughMark", // GFM `~~del~~`
  "CodeMark",
  "QuoteMark",
  "ListMark",
  "TaskMarker",
]);

/** 无序列表标记首字符（- * +）。有序列表（1. a.）保持可见，不替换为 bullet。 */
const UNORDERED_LIST_FIRST_CHAR = /^[-*+]/;

/** 大文档阈值（行数），超过则启用视口增量计算。 */
export const LARGE_DOC_LINE_THRESHOLD = 10000;

/** 光标行为防抖间隔（ms）。 */
export const DEBOUNCE_MS = 50;

export type DecoKind = "hide" | "dim";

/** 标记 decoration：对 [from,to] 应用 hide/dim 样式。 */
export interface MarkDeco {
  type: "mark";
  from: number;
  to: number;
  kind: DecoKind;
  /** 命中的语法标记节点名（用于断言/调试）。 */
  markType: string;
}

/** 替换 decoration：用 widget 替换 [from,to] 文本（列表 bullet / 分隔线）。 */
export interface WidgetDeco {
  type: "replace";
  from: number;
  to: number;
  widget: "bullet" | "hr";
}

/** 渲染 decoration：对 [from,to] 内容 span 应用渲染样式类（引用块左边框等）。 */
export interface RenderDeco {
  type: "render";
  from: number;
  to: number;
  cssClass: string;
}

export type ComputedDeco = MarkDeco | WidgetDeco | RenderDeco;

export interface ComputeInput {
  /** 完整 markdown 文本。 */
  doc: string;
  /** 光标位置（selection.main.head）。 */
  selectionHead: number;
  /** 解析后的 markdown 语法树。 */
  tree: Tree;
  /** Agent 提案范围 —— 与提案重叠的标记不隐藏（提案优先级高于 WYSIWYG 隐藏）。 */
  proposalRanges: Array<{ from: number; to: number }>;
  /** 可选视口；大文档时仅计算可见区域 ± buffer。 */
  viewport?: { from: number; to: number };
}

function isBlankLine(text: string): boolean {
  return text.trim() === "";
}

/**
 * 计算光标所在「当前段」的文档范围 [from, to]。
 * 段落定义（ADR-0008）：空行分隔的连续非空文本行。
 * 仅扫描段落本身，复杂度 O(段落大小)，与文档大小无关。
 */
export function getParagraphRange(doc: string, pos: number): { from: number; to: number } {
  // 定位光标所在行
  const lineStart = doc.lastIndexOf("\n", pos - 1) + 1;
  let lineEnd = doc.indexOf("\n", pos);
  if (lineEnd === -1) lineEnd = doc.length;

  // 向上扩展到段落起点
  let from = lineStart;
  while (from > 0) {
    const prevLineEnd = from - 1; // 前一行的换行符位置
    const prevLineStart = doc.lastIndexOf("\n", prevLineEnd - 1) + 1;
    const prevLineText = doc.slice(prevLineStart, prevLineEnd);
    if (isBlankLine(prevLineText)) break;
    from = prevLineStart;
  }

  // 向下扩展到段落终点
  let to = lineEnd;
  while (to < doc.length) {
    const nextLineStart = to + 1;
    const nextLineEnd = doc.indexOf("\n", nextLineStart);
    const nextLineEndAbs = nextLineEnd === -1 ? doc.length : nextLineEnd;
    const nextLineText = doc.slice(nextLineStart, nextLineEndAbs);
    if (isBlankLine(nextLineText)) break;
    to = nextLineEndAbs;
  }
  return { from, to };
}

/** 判断 [markFrom, markTo] 是否与任一提案范围重叠。 */
function overlapsAnyProposal(
  markFrom: number,
  markTo: number,
  proposalRanges: Array<{ from: number; to: number }>
): boolean {
  for (const r of proposalRanges) {
    if (markFrom < r.to && markTo > r.from) return true;
  }
  return false;
}

/** 判断节点是否在视口内（含边界）。 */
function inViewport(
  nodeFrom: number,
  nodeTo: number,
  viewport: { from: number; to: number } | undefined
): boolean {
  if (!viewport) return true;
  return nodeTo >= viewport.from && nodeFrom <= viewport.to;
}

/**
 * 纯函数：给定 markdown 文本 + 光标 + 语法树 → WYSIWYG decoration 描述符集合。
 *
 * 返回的描述符已按 (from, to) 排序，可直接转换为 CodeMirror DecorationSet。
 */
export function computeDecorations(input: ComputeInput): ComputedDeco[] {
  const { doc, selectionHead, tree, proposalRanges, viewport } = input;
  const para = getParagraphRange(doc, selectionHead);
  const decos: ComputedDeco[] = [];

  tree.iterate({
    enter(ref) {
      const { name, from, to } = ref;

      // 代码块整体不下降：其 ``` 反引号不隐藏（代码块 widget 是 T7.2）
      if (name === "FencedCode" || name === "CodeBlock") return false;

      // 行级标记：hide / dim
      if (INLINE_MARK_TYPES.has(name)) {
        if (!inViewport(from, to, viewport)) return;
        if (overlapsAnyProposal(from, to, proposalRanges)) return;

        const inParagraph = to >= para.from && from <= para.to;

        if (name === "ListMark") {
          const text = doc.slice(from, to);
          if (UNORDERED_LIST_FIRST_CHAR.test(text)) {
            // 无序列表：段内 dim，离开替换为 bullet widget
            if (inParagraph) {
              decos.push({ type: "mark", from, to, kind: "dim", markType: name });
            } else {
              decos.push({ type: "replace", from, to, widget: "bullet" });
            }
            return;
          }
          // 有序列表（1. a.）：段内 dim，离开保持可见（编号是功能性内容）
          if (inParagraph) {
            decos.push({ type: "mark", from, to, kind: "dim", markType: name });
          }
          return;
        }

        decos.push({
          type: "mark",
          from,
          to,
          kind: inParagraph ? "dim" : "hide",
          markType: name,
        });
        return;
      }

      // 分隔线：段内 dim，离开替换为 hr widget
      if (name === "HorizontalRule") {
        if (!inViewport(from, to, viewport)) return;
        if (overlapsAnyProposal(from, to, proposalRanges)) return;
        const inParagraph = to >= para.from && from <= para.to;
        if (inParagraph) {
          decos.push({ type: "mark", from, to, kind: "dim", markType: name });
        } else {
          decos.push({ type: "replace", from, to, widget: "hr" });
        }
        return;
      }

      // 引用块：渲染左边框（始终应用，不随光标变化）
      if (name === "Blockquote") {
        decos.push({ type: "render", from, to, cssClass: "murasaki-wysiwyg-blockquote" });
        return;
      }
    },
  });

  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  return decos;
}
