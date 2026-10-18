/**
 * WYSIWYG 装饰更新策略（#430）。
 *
 * 光标移动原本会触发全量重算（`doc.toString()` + 整棵语法树遍历），
 * 大文档下每次移动光标都是 O(文档) 的工作。实际上装饰只依赖：
 * - 光标所在行（行内标记 dim/hide 的判定）
 * - 光标是否落在某个块级节点内（代码块 / 表格 / 公式等 widget 的切换）
 *
 * 因此纯光标移动只需要重算「旧光标行 ∪ 新光标行」这一窗口：
 * 窗口外的装饰与光标位置无关，直接沿用映射后的旧装饰。
 *
 * 抽成纯函数便于单测断言「重算范围只由光标行决定，与文档长度无关」。
 */
import type { EditorState } from "@codemirror/state";

/** 光标所在行的 [from, to] 范围（不含换行符）。 */
export interface CursorLineRange {
  from: number;
  to: number;
}

export type DecorationUpdatePlan =
  /** 装饰不受影响，仅把现有装饰映射到新位置（不重算）。 */
  | { kind: "map" }
  /** 全量重算。 */
  | { kind: "full" }
  /** 只重算 [from, to] 窗口内的装饰，窗口外沿用旧装饰。 */
  | { kind: "window"; from: number; to: number };

/**
 * 光标所在行范围。非空选区返回 null —— 选区变化会改变块级 widget 的选中叠加，
 * 且范围可能横跨整篇文档，只能全量重算。
 */
export function cursorLineOf(state: EditorState): CursorLineRange | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const line = state.doc.lineAt(sel.head);
  return { from: line.from, to: line.to };
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

  const prevCursorLine = cursorLineOf(input.prev);
  const nextCursorLine = cursorLineOf(input.next);

  // 选区非空：块级 widget 的选中叠加会变化，且范围可能横跨整篇文档
  if (prevCursorLine === null || nextCursorLine === null) return { kind: "full" };

  // 光标没换行：装饰集合完全不变（位置也没变，map 是恒等映射）
  if (
    prevCursorLine.from === nextCursorLine.from &&
    prevCursorLine.to === nextCursorLine.to
  ) {
    return { kind: "map" };
  }

  // 换行：只有旧行与新行（及其上的块级节点）的 dim/hide 状态会变
  return {
    kind: "window",
    from: Math.min(prevCursorLine.from, nextCursorLine.from),
    to: Math.max(prevCursorLine.to, nextCursorLine.to),
  };
}
