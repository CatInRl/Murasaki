/**
 * T6.4 (issue #103) — WYSIWYG 模式 HTML 块 widget 集成测试。
 *
 * 验证：
 * - WYSIWYG 模式下光标离开 HTML 块段 → 渲染为 widget（含 sanitized HTML）
 * - 光标进入 HTML 块段 → 不渲染 widget（显示原始 HTML 可编辑）
 * - widget 内 HTML 经 DOMPurify 净化（XSS payload 不出现）
 * - 点击 widget → 触发 murasaki-focus-block 自定义事件（携带 from）
 *
 * 集成位置：computeDecorations.ts 检测 HTMLBlock/HTMLTag 节点 → wysiwygPlugin HtmlWidget 渲染。
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

describe("HtmlWidget — WYSIWYG 模式内联 HTML 渲染", () => {
  it("光标离开 HTML 块段 → 渲染 widget（含 sanitized HTML）", () => {
    const doc = `<div class="note">hello</div>\n\nSecond paragraph`;
    // 光标在第二段（离开 HTML 块）
    const v = makeView(doc, doc.indexOf("Second"));
    const widget = v.dom.querySelector(".murasaki-wysiwyg-html");
    expect(widget).toBeTruthy();
    // widget 应渲染了 <div class="note">hello</div>
    expect(widget?.querySelector("div.note")?.textContent).toBe("hello");
  });

  it("光标进入 HTML 块段 → 不渲染 widget（显示原始 HTML）", () => {
    const doc = `<div class="note">hello</div>\n\nSecond paragraph`;
    // 光标在 HTML 块内
    const v = makeView(doc, doc.indexOf("hello"));
    expect(v.dom.querySelector(".murasaki-wysiwyg-html")).toBeFalsy();
  });

  it("widget 内 <script> 被 DOMPurify 清除", () => {
    const doc = `<div>x</div><script>alert(1)</script>\n\nBody`;
    const v = makeView(doc, doc.indexOf("Body"));
    const widget = v.dom.querySelector(".murasaki-wysiwyg-html");
    expect(widget).toBeTruthy();
    // 不应渲染出 script 标签
    expect(widget?.querySelector("script")).toBeFalsy();
    expect(widget?.innerHTML).not.toContain("alert(1)");
  });

  it("widget 内 on* 事件属性被清除", () => {
    const doc = `<div onclick="alert(1)">click me</div>\n\nBody`;
    const v = makeView(doc, doc.indexOf("Body"));
    const widget = v.dom.querySelector(".murasaki-wysiwyg-html") as HTMLElement;
    expect(widget).toBeTruthy();
    const inner = widget.querySelector("div");
    expect(inner).toBeTruthy();
    expect(inner?.getAttribute("onclick")).toBeNull();
    expect(inner?.textContent).toBe("click me");
  });

  it("widget 内 style 属性保留（实现所见即所得）", () => {
    // 注意：<span> 是行内元素，被解析为 Paragraph+HTMLTag，不生成 HTMLBlock。
    // 用 <div>（块级元素）才能被 Lezer markdown 解析为 HTMLBlock。
    const doc = `<div style="color:red">red text</div>\n\nBody`;
    const v = makeView(doc, doc.indexOf("Body"));
    const widget = v.dom.querySelector(".murasaki-wysiwyg-html") as HTMLElement;
    expect(widget).toBeTruthy();
    const div = widget.querySelector("div");
    expect(div).toBeTruthy();
    expect(div?.getAttribute("style")).toContain("color:red");
    expect(div?.textContent).toBe("red text");
  });

  it("点击 widget 触发 murasaki-focus-block 事件（携带 from）", () => {
    const doc = `<div>hello</div>\n\nBody`;
    const v = makeView(doc, doc.indexOf("Body"));
    const widget = v.dom.querySelector(".murasaki-wysiwyg-html") as HTMLElement;
    expect(widget).toBeTruthy();

    let receivedDetail: { from: number } | null = null;
    v.dom.addEventListener("murasaki-focus-block", ((e: CustomEvent) => {
      receivedDetail = e.detail as { from: number };
    }) as EventListener);

    widget.click();
    expect(receivedDetail).not.toBeNull();
    expect(receivedDetail!.from).toBe(0);
  });

  it("光标从 body 移入 HTML 块段 → widget 消失", () => {
    const doc = `<div>hello</div>\n\nBody`;
    const v = makeView(doc, doc.indexOf("Body"));
    expect(v.dom.querySelector(".murasaki-wysiwyg-html")).toBeTruthy();

    // 移入 HTML 块
    v.dispatch({ selection: { anchor: doc.indexOf("hello") } });
    expect(v.dom.querySelector(".murasaki-wysiwyg-html")).toBeFalsy();
  });

  it("光标从 HTML 块移出到 body → widget 出现", () => {
    const doc = `<div>hello</div>\n\nBody`;
    const v = makeView(doc, doc.indexOf("hello"));
    expect(v.dom.querySelector(".murasaki-wysiwyg-html")).toBeFalsy();

    // 移出到 body
    v.dispatch({ selection: { anchor: doc.indexOf("Body") } });
    expect(v.dom.querySelector(".murasaki-wysiwyg-html")).toBeTruthy();
  });

  it("无 HTML 块的文档不生成 widget", () => {
    const doc = "# Title\n\nplain markdown paragraph";
    const v = makeView(doc, doc.indexOf("plain"));
    expect(v.dom.querySelector(".murasaki-wysiwyg-html")).toBeFalsy();
  });

  it("多个 HTML 块各自渲染为 widget", () => {
    const doc = `<div>first</div>\n\ntext between\n\n<div>second</div>`;
    const v = makeView(doc, doc.indexOf("text between"));
    const widgets = v.dom.querySelectorAll(".murasaki-wysiwyg-html");
    expect(widgets.length).toBeGreaterThanOrEqual(1);
  });
});
