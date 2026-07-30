import { describe, it, expect } from "vitest";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { paragraphKeymap } from "./useEditorCommands";

function makeView(doc: string): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        keymap.of(defaultKeymap),
        paragraphKeymap(),
      ],
    }),
    parent: host,
  });
}

function getDoc(v: EditorView): string {
  return v.state.doc.toString();
}

function setCursor(v: EditorView, pos: number): void {
  v.dispatch({ selection: { anchor: pos } });
}

function pressEnter(v: EditorView): void {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
  v.contentDOM.dispatchEvent(event);
}

describe("handleEnterInBlockquote", () => {
  it("单层引用块换行：保持 level 1", () => {
    const v = makeView("> text");
    setCursor(v, 6); // 行末
    pressEnter(v);
    expect(getDoc(v)).toBe("> text\n> ");
  });

  it("嵌套引用块换行：保持 level 2", () => {
    const v = makeView("> > text");
    setCursor(v, 8); // 行末
    pressEnter(v);
    expect(getDoc(v)).toBe("> > text\n> > ");
  });

  it("三层嵌套引用块换行：保持 level 3", () => {
    const v = makeView("> > > text");
    setCursor(v, 10); // 行末
    pressEnter(v);
    expect(getDoc(v)).toBe("> > > text\n> > > ");
  });

  it("引用块空行换行：退出引用块（单层）", () => {
    const v = makeView("> text\n> ");
    setCursor(v, 8); // 第二行行末
    pressEnter(v);
    // 空行换行 → 退出引用块
    expect(getDoc(v)).toBe("> text\n");
  });

  it("嵌套引用块空行换行：减少一层", () => {
    const v = makeView("> > text\n> > ");
    setCursor(v, 13); // 第二行行末
    pressEnter(v);
    // 空行换行 → 减少到 level 1
    const result = getDoc(v);
    expect(result).toBe("> > text\n> ");
  });

  it("引用块内含列表：交给默认处理器", () => {
    const v = makeView("> - item");
    setCursor(v, 8); // 行末
    pressEnter(v);
    // 列表续行：应保持 > - 前缀
    const result = getDoc(v);
    expect(result).toBe("> - item\n> - ");
  });

  it("嵌套引用块内含列表：交给默认处理器", () => {
    const v = makeView("> > - item");
    setCursor(v, 10); // 行末
    pressEnter(v);
    const result = getDoc(v);
    expect(result).toBe("> > - item\n> > - ");
  });

  it("非引用块行：正常换行", () => {
    const v = makeView("plain text");
    setCursor(v, 10); // 行末
    pressEnter(v);
    expect(getDoc(v)).toBe("plain text\n");
  });

  it("引用块文本中间换行：保持层级", () => {
    const v = makeView("> > text");
    setCursor(v, 6); // "te" 之后
    pressEnter(v);
    expect(getDoc(v)).toBe("> > te\n> > xt");
  });

  it("多行嵌套引用块：第二行末换行", () => {
    const v = makeView("> > line1\n> > line2");
    setCursor(v, 19); // line2 行末（19 = 文档末尾）
    pressEnter(v);
    expect(getDoc(v)).toBe("> > line1\n> > line2\n> > ");
  });
});
