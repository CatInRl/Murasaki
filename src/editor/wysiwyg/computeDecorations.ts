/**
 * WYSIWYG decoration computation — pure function (Ticket #72 / T7.1, #76 / T7.2).
 *
 * T7.1：行级标记 hide/dim + 列表 bullet / 分隔线 hr widget + 引用块左边框。
 * T7.2：块级 widget —— 代码块 Shiki 高亮 / 链接锚文本 / 图片渲染 / 表格对齐 /
 *       数学公式 KaTeX / Mermaid SVG。光标离开当前段 → widget 替换渲染；
 *       光标进入当前段 → dim 标记，显示原始 markdown 可编辑。
 *
 * 光标行为（ADR-0008）：
 * - 光标在当前段（空行分隔的连续非空行）→ 标记 dim（opacity:0.4 + 缩小）
 * - 光标离开当前段 → 标记 hide（display:none）；列表标记/分隔线替换为 widget
 * - 块级元素（代码块/链接/图片/表格/数学/Mermaid）离开段 → 整体替换为渲染 widget
 *
 * 该函数不依赖 CodeMirror Decoration 对象，返回可序列化的描述符，便于单元测试断言。
 * 块级 widget 的实际 DOM 渲染（Shiki/KaTeX/Mermaid/markdown-it 表格）在 wysiwygPlugin.ts 中完成。
 */
import type { Tree, SyntaxNode } from "@lezer/common";
// markdown-it-emoji 的完整 shortcode → unicode 映射（用于 WYSIWYG 模式渲染 emoji shortcode）
import emojiData from "markdown-it-emoji/lib/data/full.mjs";
import { findFrontmatterRange } from "./frontmatterDetection";

/** 行级语法标记节点名。命中即应用 hide/dim。 */
const INLINE_MARK_TYPES = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrikethroughMark", // GFM `~~del~~`
  "CodeMark",
  "QuoteMark",
  "ListMark",
  "TaskMarker",
  "LinkMark", // T7.2: 链接/图片的 []() 标记
  "TableDelimiter", // T7.2: 表格管道符
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

/** 替换 decoration：用 widget 替换 [from,to] 文本（列表 bullet / 分隔线 / 任务复选框）。 */
export interface WidgetDeco {
  type: "replace";
  from: number;
  to: number;
  widget: "bullet" | "hr" | "taskCheckbox";
  /** 仅 taskCheckbox 使用：是否已勾选 */
  checked?: boolean;
}

/** 渲染 decoration：对 [from,to] 内容 span 应用渲染样式类（引用块左边框等）。 */
export interface RenderDeco {
  type: "render";
  from: number;
  to: number;
  cssClass: string;
}

// ===== T7.2 块级 widget 描述符 =====

/** 代码块 widget：替换整个 FencedCode/CodeBlock，由 wysiwygPlugin 用 Shiki 高亮渲染。 */
export interface CodeBlockWidgetDeco {
  type: "blockWidget";
  widget: "codeBlock";
  from: number;
  to: number;
  lang: string;
  code: string;
}

/** Mermaid widget：替换 ```mermaid 代码块，由 wysiwygPlugin 用 mermaid.js 异步渲染 SVG。 */
export interface MermaidWidgetDeco {
  type: "blockWidget";
  widget: "mermaid";
  from: number;
  to: number;
  code: string;
}

/** 链接 widget：替换 [text](url)，渲染为蓝色下划线锚文本。 */
export interface LinkWidgetDeco {
  type: "blockWidget";
  widget: "link";
  from: number;
  to: number;
  text: string;
  url: string;
}

/** 图片 widget：替换 ![alt](url)，渲染为实际 <img>。 */
export interface ImageWidgetDeco {
  type: "blockWidget";
  widget: "image";
  from: number;
  to: number;
  alt: string;
  url: string;
}

/** 表格 widget：替换 Table 节点，由 wysiwygPlugin 用 markdown-it 渲染对齐表格 HTML。 */
export interface TableWidgetDeco {
  type: "blockWidget";
  widget: "table";
  from: number;
  to: number;
  /** 原始 markdown 表格片段（含管道符与对齐分隔行）。 */
  source: string;
}

/** 数学公式 widget：替换 $...$ / $$...$$，用 KaTeX 渲染。 */
export interface MathWidgetDeco {
  type: "blockWidget";
  widget: "math";
  from: number;
  to: number;
  expr: string;
  displayMode: boolean;
}

/** Emoji shortcode widget：替换 `:smile:` 等短代码为实际 emoji 字符。 */
export interface EmojiWidgetDeco {
  type: "blockWidget";
  widget: "emoji";
  from: number;
  to: number;
  /** 解析后的 emoji unicode 字符。 */
  emoji: string;
  /** 原始 shortcode（不含冒号），用于 eq 比较。 */
  shortcode: string;
}

/** Frontmatter 卡片 widget：替换文档起始的 `---\n...\n---` 为样式化卡片（T6.2 / #100）。 */
export interface FrontmatterWidgetDeco {
  type: "blockWidget";
  widget: "frontmatter";
  from: number;
  to: number;
  /** 去除首尾 `---`/`...` 包裹后的 YAML 文本，供卡片渲染。 */
  content: string;
}

/** HTML 块 widget（T6.4 / #103）：替换 HTMLBlock/HTMLTag 节点为渲染后的 HTML（DOMPurify 净化后）。 */
export interface HtmlWidgetDeco {
  type: "blockWidget";
  widget: "html";
  from: number;
  to: number;
  /** 原始 HTML 文本（未经净化），由 wysiwygPlugin 在 toDOM 时调用 sanitizeInlineHtml 净化。 */
  source: string;
}

export type BlockWidgetDeco =
  | CodeBlockWidgetDeco
  | MermaidWidgetDeco
  | LinkWidgetDeco
  | ImageWidgetDeco
  | TableWidgetDeco
  | MathWidgetDeco
  | EmojiWidgetDeco
  | FrontmatterWidgetDeco
  | HtmlWidgetDeco;

export type ComputedDeco = MarkDeco | WidgetDeco | RenderDeco | BlockWidgetDeco;

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

/** 判断 [from,to] 是否落在任一代码范围内（用于排除数学公式匹配）。 */
function inAnyCodeRange(
  from: number,
  to: number,
  codeRanges: Array<{ from: number; to: number }>
): boolean {
  for (const r of codeRanges) {
    if (from >= r.from && to <= r.to) return true;
  }
  return false;
}

/** 从 FencedCode 节点提取语言与代码文本。 */
function extractFencedCode(node: SyntaxNode, doc: string): { lang: string; code: string } {
  const infoNode = node.getChild("CodeInfo");
  const lang = infoNode ? doc.slice(infoNode.from, infoNode.to).trim() : "";
  const codeTextNode = node.getChild("CodeText");
  const code = codeTextNode ? doc.slice(codeTextNode.from, codeTextNode.to) : "";
  return { lang, code };
}

/** 从 Link/Image 节点提取锚文本与 URL（仅行内式 `[text](url)` 能提取）。 */
function extractAnchorData(
  node: SyntaxNode,
  doc: string
): { text: string; url: string } | null {
  const marks = node.getChildren("LinkMark");
  if (marks.length < 2) return null;
  const text = doc.slice(marks[0].to, marks[1].from);
  const urlNode = node.getChild("URL");
  const url = urlNode ? doc.slice(urlNode.from, urlNode.to) : "";
  return { text, url };
}

interface MathRange {
  from: number;
  to: number;
  expr: string;
  displayMode: boolean;
}

/**
 * 正则扫描数学公式范围（@codemirror/lang-markdown 默认不解析 $...$）。
 * 先匹配 $$...$$（displayMode=true），再匹配 $...$（displayMode=false），
 * 跳过已落在代码范围内的匹配（避免代码块/行内代码内的 $ 被误判）。
 */
function findMathRanges(
  doc: string,
  codeRanges: Array<{ from: number; to: number }>
): MathRange[] {
  const result: MathRange[] = [];
  const displayRe = /\$\$([\s\S]+?)\$\$/g;
  let m: RegExpExecArray | null;
  while ((m = displayRe.exec(doc)) !== null) {
    const from = m.index;
    const to = m.index + m[0].length;
    if (inAnyCodeRange(from, to, codeRanges)) continue;
    result.push({ from, to, expr: m[1], displayMode: true });
  }
  const inlineRe = /\$([^\$\n]+?)\$/g;
  while ((m = inlineRe.exec(doc)) !== null) {
    const from = m.index;
    const to = m.index + m[0].length;
    if (inAnyCodeRange(from, to, codeRanges)) continue;
    // 跳过与 display math 重叠的
    if (result.some((r) => r.from <= from && r.to >= to)) continue;
    result.push({ from, to, expr: m[1], displayMode: false });
  }
  return result;
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
  /** 代码范围（FencedCode/CodeBlock/InlineCode），用于排除数学公式匹配。 */
  const codeRanges: Array<{ from: number; to: number }> = [];

  tree.iterate({
    enter(ref) {
      const { name, from, to } = ref;

      // 行内代码：仅记录范围（用于排除数学公式）
      if (name === "InlineCode") {
        codeRanges.push({ from, to });
        return;
      }

      // 代码块（围栏 / 缩进）：块级 widget
      if (name === "FencedCode" || name === "CodeBlock") {
        // 块级元素：光标在节点范围内才显示源码，不依赖段落重叠
        // （否则相邻段落无空行时 para 会扩展覆盖整个块，导致 widget 不生成）
        const cursorInRange = selectionHead >= from && selectionHead <= to;
        codeRanges.push({ from, to });
        if (!inViewport(from, to, viewport)) return false;
        if (overlapsAnyProposal(from, to, proposalRanges)) return false;

        if (cursorInRange) {
          // 光标在代码块内：围栏 CodeMark 走默认 dim（继续遍历子节点）
          return true;
        }
        // 光标离开：整体替换为 widget
        if (name === "FencedCode") {
          const { lang, code } = extractFencedCode(ref.node, doc);
          if (lang.toLowerCase() === "mermaid") {
            decos.push({ type: "blockWidget", widget: "mermaid", from, to, code });
          } else {
            decos.push({ type: "blockWidget", widget: "codeBlock", from, to, lang, code });
          }
        } else {
          // 缩进代码块：整体作为代码（无语言）
          const code = doc.slice(from, to);
          decos.push({ type: "blockWidget", widget: "codeBlock", from, to, lang: "", code });
        }
        return false; // 不进入子节点（围栏 CodeMark 不再单独生成 mark deco）
      }

      // 链接 / 图片：行内 widget
      if (name === "Link" || name === "Image") {
        if (!inViewport(from, to, viewport)) return;
        if (overlapsAnyProposal(from, to, proposalRanges)) return;

        const inParagraph = to >= para.from && from <= para.to;
        if (inParagraph) {
          // 光标在段内：LinkMark 走默认 dim（继续遍历子节点）
          return;
        }
        const data = extractAnchorData(ref.node, doc);
        if (!data || !data.url) {
          // 引用式链接等无法提取 URL → 保持原样（继续遍历，LinkMark dim）
          return;
        }
        if (name === "Link") {
          decos.push({
            type: "blockWidget",
            widget: "link",
            from,
            to,
            text: data.text,
            url: data.url,
          });
        } else {
          decos.push({
            type: "blockWidget",
            widget: "image",
            from,
            to,
            alt: data.text,
            url: data.url,
          });
        }
        return false; // 不进入子节点
      }

      // 表格：块级 widget
      if (name === "Table") {
        if (!inViewport(from, to, viewport)) return false;
        if (overlapsAnyProposal(from, to, proposalRanges)) return false;

        // 块级元素：光标在节点范围内才显示源码，不依赖段落重叠
        const cursorInRange = selectionHead >= from && selectionHead <= to;
        if (cursorInRange) {
          // 光标在表格内：TableDelimiter 走默认 dim（继续遍历子节点）
          return true;
        }
        const source = doc.slice(from, to);
        decos.push({ type: "blockWidget", widget: "table", from, to, source });
        return false; // 不进入子节点
      }

      // T6.4 (#103)：HTML 块 —— 渲染为 widget（光标离开段时）
      // 仅处理 HTMLBlock（块级 HTML，覆盖完整 <tag>...</tag> 文本）。
      // 不处理 HTMLTag（行内 HTML 开标签）—— HTMLTag 节点只覆盖开标签 <span ...>，
      // 不含内容与闭合标签，无法独立渲染为有意义的 widget。
      // 行内 HTML 的渲染由预览/导出管线（sanitizeInlineHtml）保证安全与样式。
      if (name === "HTMLBlock") {
        if (!inViewport(from, to, viewport)) return false;
        if (overlapsAnyProposal(from, to, proposalRanges)) return false;

        // 块级：光标在节点范围内 → 显示源码可编辑
        const cursorInRange = selectionHead >= from && selectionHead <= to;
        if (cursorInRange) return true; // 继续遍历子节点（保持原始文本可见）

        const source = doc.slice(from, to);
        decos.push({ type: "blockWidget", widget: "html", from, to, source });
        return false; // 不进入子节点
      }

      // 行级标记：hide / dim
      if (INLINE_MARK_TYPES.has(name)) {
        if (!inViewport(from, to, viewport)) return;
        if (overlapsAnyProposal(from, to, proposalRanges)) return;

        const inParagraph = to >= para.from && from <= para.to;

        if (name === "ListMark") {
          const text = doc.slice(from, to);
          if (UNORDERED_LIST_FIRST_CHAR.test(text)) {
            // 检查是否是任务列表项：父节点 ListItem 有 TaskMarker 子节点
            // 任务列表语法 `- [ ] text` / `- [x] text`，ListMark + TaskMarker 一起替换为 checkbox
            const parent = ref.node.parent;
            const taskMarker = parent?.getChild("TaskMarker");
            if (taskMarker) {
              const checked = doc.slice(taskMarker.from, taskMarker.to).toLowerCase().includes("x");
              if (inParagraph) {
                // 段内：dim ListMark + TaskMarker（可编辑原始 markdown）
                decos.push({ type: "mark", from, to, kind: "dim", markType: name });
                decos.push({ type: "mark", from: taskMarker.from, to: taskMarker.to, kind: "dim", markType: "TaskMarker" });
              } else {
                // 离开段：把 ListMark + TaskMarker 一起替换为 checkbox widget
                decos.push({ type: "replace", from, to: taskMarker.to, widget: "taskCheckbox", checked });
              }
              return;
            }
            // 普通无序列表：段内 dim，离开替换为 bullet widget
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

  // 数学公式：正则扫描（语法树不解析 $...$）
  const mathRanges = findMathRanges(doc, codeRanges);
  for (const mr of mathRanges) {
    if (!inViewport(mr.from, mr.to, viewport)) continue;
    if (overlapsAnyProposal(mr.from, mr.to, proposalRanges)) continue;
    const inParagraph = mr.to >= para.from && mr.from <= para.to;
    if (inParagraph) continue; // 光标在段内：显示原始 markdown（可编辑）
    decos.push({
      type: "blockWidget",
      widget: "math",
      from: mr.from,
      to: mr.to,
      expr: mr.expr,
      displayMode: mr.displayMode,
    });
  }

  // Emoji shortcode：正则扫描 `:shortcode:` 并替换为 emoji widget
  // 跳过代码范围内的匹配（代码块/行内代码内的冒号不解析）
  const emojiRe = /:([a-z0-9_+-]+):/g;
  let em: RegExpExecArray | null;
  while ((em = emojiRe.exec(doc)) !== null) {
    const from = em.index;
    const to = em.index + em[0].length;
    const shortcode = em[1];
    // 查找 shortcode 对应的 emoji unicode
    const emojiChar = (emojiData as Record<string, string>)[shortcode];
    if (!emojiChar) continue; // 未知 shortcode：保持原样
    // 跳过代码范围内的匹配
    if (inAnyCodeRange(from, to, codeRanges)) continue;
    if (!inViewport(from, to, viewport)) continue;
    if (overlapsAnyProposal(from, to, proposalRanges)) continue;
    const inParagraph = to >= para.from && from <= para.to;
    if (inParagraph) continue; // 光标在段内：显示原始 shortcode（可编辑）
    decos.push({
      type: "blockWidget",
      widget: "emoji",
      from,
      to,
      emoji: emojiChar,
      shortcode,
    });
  }

  // Frontmatter 卡片：检测文档起始的 YAML frontmatter（T6.2 / #100）
  // 光标离开 frontmatter 范围 → 渲染为样式化卡片 widget；光标进入 → 显示原始文本可编辑
  const fmRange = findFrontmatterRange(doc);
  if (fmRange) {
    if (inViewport(fmRange.from, fmRange.to, viewport)) {
      if (!overlapsAnyProposal(fmRange.from, fmRange.to, proposalRanges)) {
        const cursorInRange =
          selectionHead >= fmRange.from && selectionHead <= fmRange.to;
        if (!cursorInRange) {
          decos.push({
            type: "blockWidget",
            widget: "frontmatter",
            from: fmRange.from,
            to: fmRange.to,
            content: fmRange.content,
          });
        }
      }
    }
  }

  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  return decos;
}
