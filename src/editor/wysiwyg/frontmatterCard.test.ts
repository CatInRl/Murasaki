/**
 * T6.2 (issue #100) — Frontmatter 卡片 widget 集成测试。
 *
 * 验证：
 * - WYSIWYG 模式下光标离开 frontmatter 范围 → 渲染卡片 widget（含 .front-matter-card）
 * - 光标进入 frontmatter 范围 → 不渲染卡片（显示原始 markdown 可编辑）
 * - 点击卡片 → 触发 murasaki-focus-frontmatter 自定义事件（携带 from）
 * - 无 frontmatter 的文档不生成卡片 widget
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

describe("FrontmatterCardWidget — WYSIWYG 模式 frontmatter 卡片渲染", () => {
  it("光标离开 frontmatter → 渲染 .front-matter-card", () => {
    const doc = "---\ntitle: Hello\n---\n\nBody content here";
    // 光标在 body 段（离开 frontmatter）
    const v = makeView(doc, doc.indexOf("Body"));
    expect(v.dom.querySelector(".murasaki-wysiwyg-frontmatter")).toBeTruthy();
    expect(v.dom.querySelector(".front-matter-card")).toBeTruthy();
    // 卡片内应包含 title 字段
    expect(v.dom.querySelector(".front-matter-card .fm-title")?.textContent).toBe("Hello");
  });

  it("光标在 frontmatter 内 → 不渲染卡片（显示原始文本）", () => {
    const doc = "---\ntitle: Hello\n---\n\nBody content here";
    // 光标在 title 行
    const v = makeView(doc, doc.indexOf("title"));
    expect(v.dom.querySelector(".murasaki-wysiwyg-frontmatter")).toBeFalsy();
    expect(v.dom.querySelector(".front-matter-card")).toBeFalsy();
  });

  it("无 frontmatter 的文档不生成卡片", () => {
    const doc = "# Title\n\nBody content";
    const v = makeView(doc, doc.indexOf("Body"));
    expect(v.dom.querySelector(".murasaki-wysiwyg-frontmatter")).toBeFalsy();
  });

  it("含 tags 的 frontmatter 渲染标签徽章", () => {
    const doc = "---\ntitle: Test\ntags: [a, b, c]\n---\n\nBody";
    const v = makeView(doc, doc.indexOf("Body"));
    const tags = v.dom.querySelectorAll(".front-matter-card .fm-tag");
    expect(tags.length).toBe(3);
    expect(Array.from(tags).map((t) => t.textContent)).toEqual(["a", "b", "c"]);
  });

  it("点击卡片触发 murasaki-focus-frontmatter 事件（携带 from=0）", () => {
    const doc = "---\ntitle: Hello\n---\n\nBody";
    const v = makeView(doc, doc.indexOf("Body"));
    const card = v.dom.querySelector(".murasaki-wysiwyg-frontmatter") as HTMLElement;
    expect(card).toBeTruthy();

    let receivedDetail: { from: number } | null = null;
    v.dom.addEventListener("murasaki-focus-frontmatter", ((e: CustomEvent) => {
      receivedDetail = e.detail as { from: number };
    }) as EventListener);

    card.click();
    expect(receivedDetail).not.toBeNull();
    expect(receivedDetail!.from).toBe(0);
  });

  it("光标从 body 移入 frontmatter → 卡片消失", () => {
    const doc = "---\ntitle: Hello\n---\n\nBody";
    const v = makeView(doc, doc.indexOf("Body"));
    expect(v.dom.querySelector(".murasaki-wysiwyg-frontmatter")).toBeTruthy();

    // 移入 frontmatter
    v.dispatch({ selection: { anchor: doc.indexOf("title") } });
    expect(v.dom.querySelector(".murasaki-wysiwyg-frontmatter")).toBeFalsy();
  });

  it("光标从 frontmatter 移出到 body → 卡片出现", () => {
    const doc = "---\ntitle: Hello\n---\n\nBody";
    const v = makeView(doc, doc.indexOf("title"));
    expect(v.dom.querySelector(".murasaki-wysiwyg-frontmatter")).toBeFalsy();

    // 移出到 body
    v.dispatch({ selection: { anchor: doc.indexOf("Body") } });
    expect(v.dom.querySelector(".murasaki-wysiwyg-frontmatter")).toBeTruthy();
  });

  it("frontmatter 内容变化时卡片正确渲染新内容", () => {
    // 验证不同 content 的 frontmatter 都能正确渲染卡片
    const doc1 = "---\ntitle: Old\n---\n\nBody";
    const v1 = makeView(doc1, doc1.indexOf("Body"));
    expect(v1.dom.querySelector(".fm-title")?.textContent).toBe("Old");
    v1.destroy();

    const doc2 = "---\ntitle: New\n---\n\nBody";
    const v2 = makeView(doc2, doc2.indexOf("Body"));
    expect(v2.dom.querySelector(".fm-title")?.textContent).toBe("New");
  });

  it("使用 ... 作为闭合标记也能渲染卡片", () => {
    const doc = "---\ntitle: Hello\n...\n\nBody";
    const v = makeView(doc, doc.indexOf("Body"));
    expect(v.dom.querySelector(".murasaki-wysiwyg-frontmatter")).toBeTruthy();
    expect(v.dom.querySelector(".fm-title")?.textContent).toBe("Hello");
  });
});
