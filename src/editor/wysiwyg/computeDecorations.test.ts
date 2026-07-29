import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import type { Tree } from "@lezer/common";
import {
  computeDecorations,
  getParagraphRange,
  type ComputedDeco,
  type MarkDeco,
  type WidgetDeco,
  type RenderDeco,
  type ComputeInput,
} from "./computeDecorations";

/**
 * 用 markdownLanguage（GFM 扩展）解析，确保 TaskMarker / Strikethrough 节点存在。
 * computeDecorations 与具体解析器无关，只按节点名遍历。
 */
function treeOf(doc: string): Tree {
  const state = EditorState.create({ doc, extensions: [markdownLanguage] });
  const t = ensureSyntaxTree(state, doc.length + 1);
  if (!t) throw new Error("markdown 解析失败");
  return t;
}

function compute(
  doc: string,
  head: number,
  proposalRanges: Array<{ from: number; to: number }> = []
): ComputedDeco[] {
  return computeDecorations({
    doc,
    selectionHead: head,
    tree: treeOf(doc),
    proposalRanges,
  });
}

function computeWithViewport(
  doc: string,
  head: number,
  viewport: { from: number; to: number }
): ComputedDeco[] {
  const input: ComputeInput = {
    doc,
    selectionHead: head,
    tree: treeOf(doc),
    proposalRanges: [],
    viewport,
  };
  return computeDecorations(input);
}

const marks = (d: ComputedDeco[]): MarkDeco[] => d.filter((x): x is MarkDeco => x.type === "mark");
const replaces = (d: ComputedDeco[]): WidgetDeco[] =>
  d.filter((x): x is WidgetDeco => x.type === "replace");
const renders = (d: ComputedDeco[]): RenderDeco[] =>
  d.filter((x): x is RenderDeco => x.type === "render");

// ===== getParagraphRange =====

describe("getParagraphRange", () => {
  it("单行文档 → 整篇", () => {
    expect(getParagraphRange("hello", 0)).toEqual({ from: 0, to: 5 });
  });

  it("连续非空行构成同一段落", () => {
    const doc = "aaa\nbbb\nccc";
    expect(getParagraphRange(doc, 5)).toEqual({ from: 0, to: 11 });
  });

  it("空行分隔段落（光标在下段）", () => {
    const doc = "aaa\n\nbbb";
    // 光标在 bbb
    expect(getParagraphRange(doc, 5)).toEqual({ from: 5, to: 8 });
  });

  it("空行分隔段落（光标在上段）", () => {
    const doc = "aaa\n\nbbb";
    expect(getParagraphRange(doc, 1)).toEqual({ from: 0, to: 3 });
  });

  it("仅空白的行也视作空行分隔", () => {
    const doc = "aaa\n   \nbbb";
    expect(getParagraphRange(doc, 8)).toEqual({ from: 8, to: 11 });
  });
});

// ===== 强调（粗体/斜体） =====

describe("computeDecorations — 强调标记", () => {
  it("**bold** 光标在段内 → 两个 EmphasisMark 均 dim", () => {
    const d = compute("**bold**", 4);
    const ms = marks(d).filter((m) => m.markType === "EmphasisMark");
    expect(ms).toHaveLength(2);
    expect(ms.every((m) => m.kind === "dim")).toBe(true);
  });

  it("光标离开当前段 → EmphasisMark 全部 hide", () => {
    const doc = "**bold**\n\nplain";
    const d = compute(doc, 10); // 光标在 plain
    const ms = marks(d).filter((m) => m.markType === "EmphasisMark");
    expect(ms).toHaveLength(2);
    expect(ms.every((m) => m.kind === "hide")).toBe(true);
  });

  it("_italic_ 同样被识别为 EmphasisMark", () => {
    const d = compute("_italic_", 3);
    const ms = marks(d).filter((m) => m.markType === "EmphasisMark");
    expect(ms).toHaveLength(2);
    expect(ms.every((m) => m.kind === "dim")).toBe(true);
  });

  it("~~strikethrough~~（GFM）标记同样隐藏", () => {
    const doc = "~~del~~\n\nbody";
    const d = compute(doc, 9);
    const ms = marks(d).filter((m) => m.markType === "StrikethroughMark");
    expect(ms.length).toBeGreaterThanOrEqual(2);
    expect(ms.every((m) => m.kind === "hide")).toBe(true);
  });
});

// ===== 标题 =====

describe("computeDecorations — 标题标记", () => {
  it("# Title 光标在段内 → HeaderMark dim", () => {
    const d = compute("# Title", 3);
    const hm = marks(d).filter((m) => m.markType === "HeaderMark");
    expect(hm.length).toBeGreaterThanOrEqual(1);
    expect(hm.every((m) => m.kind === "dim")).toBe(true);
  });

  it("光标离开 → HeaderMark hide", () => {
    const doc = "# Title\n\nbody";
    const d = compute(doc, 10);
    const hm = marks(d).filter((m) => m.markType === "HeaderMark");
    expect(hm.length).toBeGreaterThanOrEqual(1);
    expect(hm.every((m) => m.kind === "hide")).toBe(true);
  });
});

// ===== 行内代码 =====

describe("computeDecorations — 行内代码", () => {
  it("`code` 光标离开 → CodeMark hide", () => {
    const doc = "`code`\n\nbody";
    const d = compute(doc, 8);
    const cm = marks(d).filter((m) => m.markType === "CodeMark");
    expect(cm).toHaveLength(2);
    expect(cm.every((m) => m.kind === "hide")).toBe(true);
  });

  it("`code` 光标在段内 → CodeMark dim", () => {
    const d = compute("`code`", 3);
    const cm = marks(d).filter((m) => m.markType === "CodeMark");
    expect(cm).toHaveLength(2);
    expect(cm.every((m) => m.kind === "dim")).toBe(true);
  });

  it("代码块（FencedCode）的 ``` 反引号不隐藏", () => {
    const doc = "```js\nconsole.log(1)\n```\n\nbody";
    const d = compute(doc, 30); // 光标在 body
    // FencedCode 内的 CodeMark 不应产生 decoration
    const cm = marks(d).filter((m) => m.markType === "CodeMark");
    expect(cm).toHaveLength(0);
  });
});

// ===== 引用块 =====

describe("computeDecorations — 引用块", () => {
  it("> quote 光标离开 → QuoteMark hide + 渲染左边框", () => {
    const doc = "> quote\n\nbody";
    const d = compute(doc, 10);
    expect(marks(d).some((m) => m.markType === "QuoteMark" && m.kind === "hide")).toBe(true);
    expect(
      renders(d).some((r) => r.cssClass === "murasaki-wysiwyg-blockquote")
    ).toBe(true);
  });

  it("> quote 光标在段内 → QuoteMark dim", () => {
    const d = compute("> quote", 4);
    expect(marks(d).some((m) => m.markType === "QuoteMark" && m.kind === "dim")).toBe(true);
  });
});

// ===== 列表 =====

describe("computeDecorations — 列表", () => {
  it("- item 光标离开 → bullet widget 替换标记", () => {
    const doc = "- item\n\nbody";
    const d = compute(doc, 8);
    expect(replaces(d).some((r) => r.widget === "bullet")).toBe(true);
  });

  it("- item 光标在段内 → ListMark dim（不替换）", () => {
    const d = compute("- item", 3);
    expect(marks(d).some((m) => m.markType === "ListMark" && m.kind === "dim")).toBe(true);
    expect(replaces(d).some((r) => r.widget === "bullet")).toBe(false);
  });

  it("* 和 + 也识别为无序列表 bullet", () => {
    const doc = "* a\n\nbody";
    expect(replaces(compute(doc, 6)).some((r) => r.widget === "bullet")).toBe(true);
  });

  it("1. 有序列表不替换为 bullet（编号保持可见）", () => {
    const doc = "1. item\n\nbody";
    const d = compute(doc, 9);
    expect(replaces(d).some((r) => r.widget === "bullet")).toBe(false);
  });

  it("1. 有序列表光标在段内 → ListMark dim", () => {
    const d = compute("1. item", 3);
    expect(marks(d).some((m) => m.markType === "ListMark" && m.kind === "dim")).toBe(true);
  });

  it("- [ ] 任务列表项 → TaskMarker 隐藏（光标离开）", () => {
    const doc = "- [ ] item\n\nbody";
    const d = compute(doc, 12);
    expect(
      marks(d).some((m) => m.markType === "TaskMarker" && m.kind === "hide")
    ).toBe(true);
  });
});

// ===== 分隔线 =====

describe("computeDecorations — 分隔线", () => {
  it("--- 光标离开 → hr widget 替换", () => {
    const doc = "---\n\nbody";
    const d = compute(doc, 5);
    expect(replaces(d).some((r) => r.widget === "hr")).toBe(true);
  });

  it("--- 光标在段内 → dim（不替换）", () => {
    const d = compute("---", 1);
    expect(
      marks(d).some((m) => m.markType === "HorizontalRule" && m.kind === "dim")
    ).toBe(true);
    expect(replaces(d).some((r) => r.widget === "hr")).toBe(false);
  });
});

// ===== Agent 提案优先级 =====

describe("computeDecorations — Agent 提案优先级", () => {
  it("完全落在提案范围内的标记不隐藏", () => {
    const doc = "**bold**\n\nbody";
    // 提案覆盖整个 **bold**（0..8）
    const d = compute(doc, 10, [{ from: 0, to: 8 }]);
    const ms = marks(d).filter((m) => m.markType === "EmphasisMark");
    expect(ms).toHaveLength(0);
  });

  it("未与提案重叠的标记仍然 hide", () => {
    const doc = "**bold**\n\nbody";
    // 提案仅覆盖开头 0..1，会吃掉首个标记，但末尾标记仍 hide
    const d = compute(doc, 10, [{ from: 0, to: 1 }]);
    const ms = marks(d).filter((m) => m.markType === "EmphasisMark");
    expect(ms.length).toBeGreaterThanOrEqual(1);
    expect(ms.every((m) => m.kind === "hide")).toBe(true);
  });
});

// ===== 视口裁剪（大文档增量） =====

describe("computeDecorations — 视口裁剪", () => {
  it("视口外的标记被跳过，只返回视口内的", () => {
    const doc = "**a**\n\n**b**";
    // **a** 在 [0,5)，**b** 在 [7,12)；视口只覆盖前半
    const d = computeWithViewport(doc, 9, { from: 0, to: 5 });
    const ms = marks(d).filter((m) => m.markType === "EmphasisMark");
    // 视口 [0,5] 只含第一组强调标记，第二组被裁掉
    expect(ms.length).toBeGreaterThanOrEqual(1);
    expect(ms.every((m) => m.to <= 5)).toBe(true);
  });
});

// ===== 排序 =====

describe("computeDecorations — 排序", () => {
  it("返回结果按 (from, to) 升序", () => {
    const doc = "# H\n\n**b**\n\n- i\n\n> q";
    const d = compute(doc, 0);
    for (let i = 1; i < d.length; i++) {
      const a = d[i - 1];
      const b = d[i];
      expect(a.from < b.from || (a.from === b.from && a.to <= b.to)).toBe(true);
    }
  });
});
