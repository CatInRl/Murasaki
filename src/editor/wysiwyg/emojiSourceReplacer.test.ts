/**
 * T6.1 (issue #99) — Emoji 短代码源码替换集成测试。
 *
 * 验证 ViewPlugin 行为：WYSIWYG 模式下光标离开段时，段内 `:shortcode:` 被替换为
 * 实际 emoji 字符写入源码。光标在段内时不替换。
 */
import { describe, it, expect, afterEach } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { wysiwygExtensions } from "./wysiwygPlugin";

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

function makeView(doc: string, cursorPos: number): EditorView {
  const base = EditorState.create({
    doc,
    extensions: [markdownLanguage, ...wysiwygExtensions] as Extension[],
  });
  ensureSyntaxTree(base, doc.length + 1);
  const state = base.update({ selection: { anchor: cursorPos } }).state;
  view = new EditorView({ state });
  return view;
}

describe("emojiSourceReplacer — WYSIWYG 模式光标离段触发源码替换", () => {
  it("光标离开段后，段内 :smile: 被替换为 emoji 字符", async () => {
    const doc = "Hello :smile: world\n\nsecond paragraph";
    // 光标先在第一段（含 shortcode）
    const v = makeView(doc, 5);
    // 离开第一段，移到第二段
    v.dispatch({ selection: { anchor: doc.indexOf("second") } });
    // view.dispatch 在 plugin update 内的派发会被 CM6 排队，需等一个 microtask
    await Promise.resolve();
    expect(v.state.doc.toString()).toContain("😄");
    expect(v.state.doc.toString()).not.toContain(":smile:");
  });

  it("光标仍在段内时不替换", async () => {
    const doc = "Hello :smile: world";
    const v = makeView(doc, 5);
    // 在同段内移动光标
    v.dispatch({ selection: { anchor: 10 } });
    await Promise.resolve();
    expect(v.state.doc.toString()).toContain(":smile:");
    expect(v.state.doc.toString()).not.toContain("😄");
  });

  it("多个 shortcode 同时被替换", async () => {
    const doc = ":smile: :heart: :rocket:\n\nnext";
    const v = makeView(doc, 3);
    v.dispatch({ selection: { anchor: doc.indexOf("next") } });
    await Promise.resolve();
    const result = v.state.doc.toString();
    expect(result).toContain("😄");
    expect(result).toContain("❤️");
    expect(result).toContain("🚀");
    expect(result).not.toContain(":smile:");
    expect(result).not.toContain(":heart:");
    expect(result).not.toContain(":rocket:");
  });

  it("未知 shortcode 不被替换", async () => {
    const doc = ":smile: :not_real_emoji_xyz:\n\nnext";
    const v = makeView(doc, 3);
    v.dispatch({ selection: { anchor: doc.indexOf("next") } });
    await Promise.resolve();
    const result = v.state.doc.toString();
    expect(result).toContain("😄");
    expect(result).toContain(":not_real_emoji_xyz:");
  });

  it("代码块内的 shortcode 不被替换", async () => {
    const doc = ":smile:\n\n```\n:heart: :rocket:\n```\n\nnext";
    const v = makeView(doc, 2);
    v.dispatch({ selection: { anchor: doc.indexOf("next") } });
    await Promise.resolve();
    const result = v.state.doc.toString();
    // 第一段的 :smile: 被替换
    expect(result).toContain("😄");
    // 代码块内的 shortcode 保留
    expect(result).toContain(":heart:");
    expect(result).toContain(":rocket:");
  });

  it("行内代码内的 shortcode 不被替换", async () => {
    const doc = ":smile: and `:heart: code`\n\nnext";
    const v = makeView(doc, 2);
    v.dispatch({ selection: { anchor: doc.indexOf("next") } });
    await Promise.resolve();
    const result = v.state.doc.toString();
    expect(result).toContain("😄");
    expect(result).toContain(":heart:");
  });

  it("替换后回到该段不再触发（emoji 已是字面字符）", async () => {
    const doc = ":smile:\n\nnext";
    const v = makeView(doc, 2);
    // 离开 → 替换
    v.dispatch({ selection: { anchor: doc.indexOf("next") } });
    await Promise.resolve();
    expect(v.state.doc.toString()).toContain("😄");
    // 回到第一段
    v.dispatch({ selection: { anchor: 0 } });
    await Promise.resolve();
    // 再次离开
    v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf("next") } });
    await Promise.resolve();
    // 仍然只有一个 emoji，无异常
    expect(v.state.doc.toString().match(/😄/g)).toHaveLength(1);
  });
});
