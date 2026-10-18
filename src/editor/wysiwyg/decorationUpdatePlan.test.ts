import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { planDecorationUpdate } from "./decorationUpdatePlan";

/**
 * #430：光标移动的装饰更新策略。
 *
 * 核心断言：纯光标跨行移动只重算「旧行 ∪ 新行」窗口，范围与文档长度无关。
 */
describe("planDecorationUpdate", () => {
  const doc = "aaa\nbbb\nccc\n";
  const at = (head: number): EditorState =>
    EditorState.create({ doc, selection: EditorSelection.cursor(head) });

  const plan = (prev: EditorState, next: EditorState, docChanged = false) =>
    planDecorationUpdate({ docChanged, recomputeRequested: false, prev, next });

  it("文档改动 → 全量重算", () => {
    expect(plan(at(1), at(1), true)).toEqual({ kind: "full" });
  });

  it("显式重算请求（语法树解析完成）→ 全量重算", () => {
    expect(
      planDecorationUpdate({
        docChanged: false,
        recomputeRequested: true,
        prev: at(1),
        next: at(1),
      })
    ).toEqual({ kind: "full" });
  });

  it("光标在同一行内移动 → 只映射，不重算", () => {
    expect(plan(at(0), at(2))).toEqual({ kind: "map" });
  });

  it("光标跨行移动 → 只重算旧行与新行的并集", () => {
    // 第 1 行 [0,3]、第 2 行 [4,7]
    expect(plan(at(1), at(5))).toEqual({ kind: "window", from: 0, to: 7 });
    // 反向移动（向上）同样是两者并集
    expect(plan(at(5), at(1))).toEqual({ kind: "window", from: 0, to: 7 });
  });

  it("选区非空 → 全量重算（块级 widget 的选中叠加会变）", () => {
    const selected = EditorState.create({
      doc,
      selection: EditorSelection.range(0, 2),
    });
    expect(plan(at(0), selected)).toEqual({ kind: "full" });
    expect(plan(selected, at(0))).toEqual({ kind: "full" });
  });

  it("重算窗口只由光标行决定，与文档长度无关", () => {
    const head = 1;
    const shortDoc = "aaa\nbbb\n";
    const longDoc = "aaa\nbbb\n" + "line\n".repeat(20000);

    const shortPlan = plan(
      EditorState.create({ doc: shortDoc, selection: EditorSelection.cursor(head) }),
      EditorState.create({ doc: shortDoc, selection: EditorSelection.cursor(5) })
    );
    const longPlan = plan(
      EditorState.create({ doc: longDoc, selection: EditorSelection.cursor(head) }),
      EditorState.create({ doc: longDoc, selection: EditorSelection.cursor(5) })
    );

    expect(shortPlan).toEqual({ kind: "window", from: 0, to: 7 });
    expect(longPlan).toEqual(shortPlan);
  });
});
