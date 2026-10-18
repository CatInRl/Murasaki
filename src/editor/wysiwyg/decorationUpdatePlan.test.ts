import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { planDecorationUpdate } from "./decorationUpdatePlan";

/**
 * #430：光标移动的装饰更新策略。
 *
 * 核心断言：纯光标移动只重算光标周围的窗口，范围与文档长度无关。
 */
function stateOf(doc: string, head: number): EditorState {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(head),
    extensions: [markdownLanguage],
  });
  // 预解析语法树：块级节点范围依赖 syntaxTree
  ensureSyntaxTree(state, doc.length + 1);
  return state;
}

function plan(prev: EditorState, next: EditorState, docChanged = false) {
  return planDecorationUpdate({ docChanged, recomputeRequested: false, prev, next });
}

describe("planDecorationUpdate", () => {
  const doc = "aaa\nbbb\n\nccc\nddd\n";

  it("文档改动 → 全量重算", () => {
    expect(plan(stateOf(doc, 1), stateOf(doc, 1), true)).toEqual({ kind: "full" });
  });

  it("显式重算请求（语法树解析完成）→ 全量重算", () => {
    expect(
      planDecorationUpdate({
        docChanged: false,
        recomputeRequested: true,
        prev: stateOf(doc, 1),
        next: stateOf(doc, 1),
      })
    ).toEqual({ kind: "full" });
  });

  it("光标在同一行内移动 → 只映射，不重算", () => {
    expect(plan(stateOf(doc, 0), stateOf(doc, 2))).toEqual({ kind: "map" });
  });

  it("光标跨行移动 → 只重算两处所在段落的并集", () => {
    // 段落 1 = [0,7]（aaa/bbb），段落 2 = [9,16]（ccc/ddd）
    expect(plan(stateOf(doc, 1), stateOf(doc, 10))).toEqual({
      kind: "window",
      from: 0,
      to: 16,
    });
    // 反向移动（向上）同样是两者并集
    expect(plan(stateOf(doc, 10), stateOf(doc, 1))).toEqual({
      kind: "window",
      from: 0,
      to: 16,
    });
  });

  it("段落内换行：窗口覆盖整个段落（多行公式的起点在光标行之上）", () => {
    const formula = "$$\nx = 1\n$$\n\nafter\n";
    // 从公式块最后一行移到块后段落：窗口必须包含整个 $$ 块
    expect(plan(stateOf(formula, 8), stateOf(formula, 13))).toEqual({
      kind: "window",
      from: 0,
      to: 18,
    });
  });

  it("进出代码块：窗口覆盖整块（围栏与块内标记一起切换 dim/hide）", () => {
    const code = "para\n\n```js\nconst a = 1;\n```\n\nafter\n";
    const inside = code.indexOf("const");
    const after = code.indexOf("after");
    const blockFrom = code.indexOf("```");
    const blockTo = code.indexOf("```", blockFrom + 3) + 3;

    expect(plan(stateOf(code, inside), stateOf(code, after))).toEqual({
      kind: "window",
      from: Math.min(blockFrom, code.indexOf("after")),
      to: Math.max(blockTo, after + "after".length),
    });
  });

  it("选区非空 → 全量重算（块级 widget 的选中叠加会变）", () => {
    const selected = EditorState.create({
      doc,
      selection: EditorSelection.range(0, 2),
    });
    expect(plan(stateOf(doc, 0), selected)).toEqual({ kind: "full" });
    expect(plan(selected, stateOf(doc, 0))).toEqual({ kind: "full" });
  });

  it("重算窗口只由光标位置决定，与文档长度无关", () => {
    const shortDoc = "aaa\nbbb\n\nccc\n";
    const longDoc = "aaa\nbbb\n\n" + "line\n".repeat(20000);

    const shortPlan = plan(stateOf(shortDoc, 1), stateOf(shortDoc, 5));
    const longPlan = plan(stateOf(longDoc, 1), stateOf(longDoc, 5));

    expect(shortPlan).toEqual({ kind: "window", from: 0, to: 7 });
    expect(longPlan).toEqual(shortPlan);
  });
});
