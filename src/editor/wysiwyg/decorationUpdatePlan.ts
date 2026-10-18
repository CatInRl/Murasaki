/**
 * WYSIWYG 装饰更新策略（#430）。
 *
 * 光标移动原本会触发全量重算（`doc.toString()` + 整棵语法树遍历 + 全部 widget 重建），
 * 大文档下每次移动光标都是 O(文档) 的工作。实际上装饰只依赖：
 * - 光标所在行（行内标记 dim/hide 的判定）
 * - 光标是否落在某个块级节点内（代码块 / 表格 / 公式等 widget 的切换）
 *
 * 因此纯光标移动只需要重算「旧光标位置 ∩ 新光标位置」周围的窗口：
 * 窗口外的装饰与光标位置无关，直接沿用映射后的旧装饰。
 *
 * 窗口必须覆盖整块，否则会漏算跨行结构：
 * - 段落范围：`$$...$$` 等多行公式由正则扫描，起点可能在光标行之上；
 * - 块级节点范围：进出代码块 / HTML 块 / 表格 / 引用时，整块的围栏与分隔符
 *   都要在 dim / hide 之间切换，只重算光标行会留下半块裸源码。
 *
 * 抽成纯函数便于单测断言「重算范围只由光标位置决定，与文档长度无关」。
 */
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { syntaxTree } from "@codemirror/language";
import { startsBlockLine } from "./computeDecorations";

/** 文档范围 [from, to]。 */
export interface TextRange {
  from: number;
  to: number;
}

export type DecorationUpdatePlan =
  /** 装饰不受影响，仅把现有装饰映射到新位置（不重算）。 */
  | { kind: "map" }
  /** 全量重算。 */
  | { kind: "full" }
  /** 只重算 [from, to] 窗口内的装饰，窗口外沿用旧装饰。 */
  | ({ kind: "window" } & TextRange);

/** 需要整块重算的块级节点（进出时整块的标记都要切换 dim / hide）。 */
const WHOLE_BLOCK_NODES = new Set(["FencedCode", "CodeBlock", "HTMLBlock", "Table", "Blockquote"]);

/**
 * 光标所在行范围。非空选区返回 null —— 选区变化会改变块级 widget 的选中叠加，
 * 且范围可能横跨整篇文档，只能全量重算。
 */
function cursorLineOf(state: EditorState): TextRange | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const line = state.doc.lineAt(sel.head);
  return { from: line.from, to: line.to };
}

/**
 * 光标所在段落的范围（空行 / 可中断段落的块级起始行分隔）。
 *
 * 用 EditorState.doc 逐行扫描，避免为算窗口再拷一份全文。
 */
function paragraphRangeOf(state: EditorState, pos: number): TextRange {
  const doc = state.doc;
  const head = doc.lineAt(pos);
  if (startsBlockLine(head.text)) return { from: head.from, to: head.to };

  let from = head.from;
  for (let number = head.number - 1; number >= 1; number--) {
    const line = doc.line(number);
    if (line.text.trim() === "" || startsBlockLine(line.text)) break;
    from = line.from;
  }

  let to = head.to;
  for (let number = head.number + 1; number <= doc.lines; number++) {
    const line = doc.line(number);
    if (line.text.trim() === "" || startsBlockLine(line.text)) break;
    to = line.to;
  }

  return { from, to };
}

/**
 * 光标所在块级节点的范围（代码块 / HTML 块 / 表格 / 引用块）。
 * 不在这些块内时返回 null。
 */
function enclosingBlockRangeOf(state: EditorState, pos: number): TextRange | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
  for (; node; node = node.parent) {
    if (WHOLE_BLOCK_NODES.has(node.name)) return { from: node.from, to: node.to };
  }
  return null;
}

/** 光标位置需要整体重算的范围（段落 + 块级节点）。 */
function recomputeRangeAt(state: EditorState, pos: number): TextRange {
  const paragraph = paragraphRangeOf(state, pos);
  const block = enclosingBlockRangeOf(state, pos);
  if (!block) return paragraph;
  return {
    from: Math.min(paragraph.from, block.from),
    to: Math.max(paragraph.to, block.to),
  };
}

export interface PlanInput {
  /** 事务是否改动文档 */
  docChanged: boolean;
  /** 是否收到显式重算请求（语法树异步解析完成等） */
  recomputeRequested: boolean;
  /** 事务前的 EditorState */
  prev: EditorState;
  /** 事务后的 EditorState */
  next: EditorState;
}

export function planDecorationUpdate(input: PlanInput): DecorationUpdatePlan {
  const { docChanged, recomputeRequested } = input;

  // 文档改动会平移所有位置、改写节点内容；语法树完成解析同理 —— 只能全量重算
  if (docChanged || recomputeRequested) return { kind: "full" };

  // 选区非空：块级 widget 的选中叠加会变化，且范围可能横跨整篇文档
  if (cursorLineOf(input.prev) === null || cursorLineOf(input.next) === null) {
    return { kind: "full" };
  }

  const prevHead = input.prev.selection.main.head;
  const nextHead = input.next.selection.main.head;

  // 光标没换行：装饰集合完全不变（位置也没变，map 是恒等映射）
  if (input.prev.doc.lineAt(prevHead).from === input.next.doc.lineAt(nextHead).from) {
    return { kind: "map" };
  }

  // 换行：只有旧位置与新位置所在段落 / 块级节点的 dim/hide 状态会变
  const prevRange = recomputeRangeAt(input.prev, prevHead);
  const nextRange = recomputeRangeAt(input.next, nextHead);
  return {
    kind: "window",
    from: Math.min(prevRange.from, nextRange.from),
    to: Math.max(prevRange.to, nextRange.to),
  };
}
