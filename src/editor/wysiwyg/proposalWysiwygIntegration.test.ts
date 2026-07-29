/**
 * WYSIWYG × Agent 提案兼容性集成测试（Ticket #79 / T7.4）
 *
 * 验收标准：
 * - 三种编辑模式（source/split/wysiwyg）下 Agent 提案都能正常渲染和接受/拒绝
 * - WYSIWYG 模式下提案覆盖范围语法标记可见（提案优先级高于隐藏 decoration）
 *
 * 模式与编辑器扩展的对应（T7.3 尚未合并，此处直接以扩展组合构造等价视图）：
 * - source / split：[proposalField]（split 与 source 共享同一编辑器扩展，差异仅在预览面板）
 * - wysiwyg：[proposalField, ...wysiwygExtensions]
 */
import { describe, it, expect, afterEach } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import {
  proposalField,
  addProposalEffect,
  proposalActionEffect,
  type Proposal,
} from "../../agent/proposals";
import { wysiwygExtensions } from "./wysiwygPlugin";
import { DEBOUNCE_MS } from "./computeDecorations";

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

/** 构造一个带指定扩展的 EditorView，光标放在 cursorPos。强制小文档完整解析。 */
function makeView(extensions: Extension[], doc: string, cursorPos: number): EditorView {
  const base = EditorState.create({
    doc,
    extensions: [markdownLanguage, ...extensions],
  });
  // 强制完整解析，确保 wysiwygPlugin 能遍历到 EmphasisMark 节点
  ensureSyntaxTree(base, doc.length + 1);
  const state = base.update({ selection: { anchor: cursorPos } }).state;
  view = new EditorView({ state });
  return view;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 构造一个在文档末尾插入内容的 pending proposal。 */
function insertProposal(doc: string, id: string, content: string): Proposal {
  return {
    id,
    type: "insert",
    from: doc.length,
    to: doc.length,
    content,
    status: "pending",
    lineCount: 1,
    label: "test insert",
  };
}

// ===== 三种模式下提案渲染与接受/拒绝 =====

describe("三种模式下 Agent 提案渲染与接受/拒绝", () => {
  it("source 模式（仅 proposalField）：注入提案 → 渲染 accept/reject 按钮", () => {
    const doc = "hello world";
    const v = makeView([proposalField], doc, doc.length);
    v.dispatch({ effects: addProposalEffect.of(insertProposal(doc, "p1", "**new**")) });

    expect(v.dom.querySelector(".cm-proposal-buttons")).toBeTruthy();
    expect(v.dom.querySelector(".cm-proposal-accept")).toBeTruthy();
    expect(v.dom.querySelector(".cm-proposal-reject")).toBeTruthy();
  });

  it("split 模式（编辑器扩展同 source）：注入提案 → 渲染 accept/reject 按钮", () => {
    const doc = "split mode doc";
    const v = makeView([proposalField], doc, doc.length);
    v.dispatch({ effects: addProposalEffect.of(insertProposal(doc, "p2", "## 标题")) });

    expect(v.dom.querySelector(".cm-proposal-buttons")).toBeTruthy();
    expect(v.dom.querySelector(".cm-proposal-accept")).toBeTruthy();
    expect(v.dom.querySelector(".cm-proposal-reject")).toBeTruthy();
  });

  it("wysiwyg 模式（proposalField + wysiwygExtensions）：注入提案 → 渲染 accept/reject 按钮", () => {
    const doc = "# 标题\n\n正文";
    const v = makeView([proposalField, ...wysiwygExtensions], doc, doc.length);
    v.dispatch({ effects: addProposalEffect.of(insertProposal(doc, "p3", "新段")) });

    expect(v.dom.querySelector(".cm-proposal-buttons")).toBeTruthy();
    expect(v.dom.querySelector(".cm-proposal-accept")).toBeTruthy();
    expect(v.dom.querySelector(".cm-proposal-reject")).toBeTruthy();
  });

  it("接受提案后按钮消失（wysiwyg 模式）", () => {
    const doc = "# 标题\n\n正文";
    const v = makeView([proposalField, ...wysiwygExtensions], doc, doc.length);
    v.dispatch({ effects: addProposalEffect.of(insertProposal(doc, "p4", "新段")) });
    expect(v.dom.querySelector(".cm-proposal-buttons")).toBeTruthy();

    v.dispatch({ effects: proposalActionEffect.of({ id: "p4", action: "accept" }) });
    expect(v.dom.querySelector(".cm-proposal-buttons")).toBeFalsy();
  });

  it("拒绝提案后按钮消失（wysiwyg 模式）", () => {
    const doc = "# 标题\n\n正文";
    const v = makeView([proposalField, ...wysiwygExtensions], doc, doc.length);
    v.dispatch({ effects: addProposalEffect.of(insertProposal(doc, "p5", "新段")) });

    v.dispatch({ effects: proposalActionEffect.of({ id: "p5", action: "reject" }) });
    expect(v.dom.querySelector(".cm-proposal-buttons")).toBeFalsy();
  });
});

// ===== WYSIWYG 模式提案优先级（覆盖范围标记可见）=====

describe("WYSIWYG 模式提案优先级（覆盖范围标记可见）", () => {
  it("提案覆盖范围内的标记保持可见（不隐藏）", async () => {
    const doc = "**bold**\n\nplain";
    // 光标在 plain 段 → **bold** 所在段落离开当前段 → EmphasisMark 应被隐藏
    const v = makeView([proposalField, ...wysiwygExtensions], doc, doc.indexOf("plain"));

    const hideBefore = v.dom.querySelectorAll(".murasaki-wysiwyg-mark-hide").length;
    expect(hideBefore).toBeGreaterThanOrEqual(1);

    // 注入提案覆盖整个 **bold** [0,8)
    v.dispatch({
      effects: addProposalEffect.of({
        id: "r1",
        type: "replace",
        from: 0,
        to: 8,
        content: "replaced",
        status: "pending",
        lineCount: 1,
        label: "test replace",
      }),
    });
    // proposal 装饰立即渲染
    expect(v.dom.querySelector(".cm-proposal-buttons")).toBeTruthy();

    // WYSIWYG 重算（防抖 50ms 后触发空事务刷新 decorations）
    await sleep(DEBOUNCE_MS + 30);

    // 覆盖范围内的标记不再隐藏
    expect(v.dom.querySelectorAll(".murasaki-wysiwyg-mark-hide").length).toBe(0);
  });

  it("提案范围外的标记仍然隐藏", async () => {
    const doc = "**a**\n\n**b**\n\nplain";
    const v = makeView([proposalField, ...wysiwygExtensions], doc, doc.indexOf("plain"));

    const hideBefore = v.dom.querySelectorAll(".murasaki-wysiwyg-mark-hide").length;
    expect(hideBefore).toBeGreaterThanOrEqual(2);

    // 提案仅覆盖第一组 **a** [0,5)
    v.dispatch({
      effects: addProposalEffect.of({
        id: "r2",
        type: "replace",
        from: 0,
        to: 5,
        content: "A",
        status: "pending",
        lineCount: 1,
        label: "test replace",
      }),
    });
    await sleep(DEBOUNCE_MS + 30);

    // 第一组标记取消隐藏，第二组 **b** 的标记仍然隐藏
    const hideAfter = v.dom.querySelectorAll(".murasaki-wysiwyg-mark-hide").length;
    expect(hideAfter).toBeGreaterThan(0);
    expect(hideAfter).toBeLessThan(hideBefore);
  });

  it("提案解决（接受）后，覆盖范围的标记恢复隐藏", async () => {
    const doc = "**bold**\n\nplain";
    const v = makeView([proposalField, ...wysiwygExtensions], doc, doc.indexOf("plain"));

    v.dispatch({
      effects: addProposalEffect.of({
        id: "r3",
        type: "replace",
        from: 0,
        to: 8,
        content: "replaced",
        status: "pending",
        lineCount: 1,
        label: "test replace",
      }),
    });
    await sleep(DEBOUNCE_MS + 30);
    // 提案 pending 时标记可见
    expect(v.dom.querySelectorAll(".murasaki-wysiwyg-mark-hide").length).toBe(0);

    // 接受提案 → 不再 pending → 标记恢复隐藏
    v.dispatch({ effects: proposalActionEffect.of({ id: "r3", action: "accept" }) });
    await sleep(DEBOUNCE_MS + 30);
    expect(v.dom.querySelectorAll(".murasaki-wysiwyg-mark-hide").length).toBeGreaterThanOrEqual(1);
  });
});
