import { describe, it, expect } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import {
  setHeading,
  toggleList,
  toggleBlockquote,
  toggleCodeBlock,
  insertHorizontalRule,
  insertTable,
  toggleInline,
  insertLink,
  insertImage,
  getActiveFormats,
  createTestView,
  setSelection,
  getDoc,
} from "./useEditorCommands";

/**
 * 创建测试用 EditorView（附加到 jsdom DOM，避免 viewport 计算失败）
 */
function makeView(doc: string): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return new EditorView({
    state: EditorState.create({ doc }),
    parent: host,
  });
}

describe("useEditorCommands", () => {
  describe("setHeading", () => {
    it("将普通行转为 H1", () => {
      const v = makeView("hello");
      setSelection(v, 0);
      setHeading(v, 1);
      expect(getDoc(v)).toBe("# hello");
    });

    it("将普通行转为 H3", () => {
      const v = makeView("title");
      setSelection(v, 0);
      setHeading(v, 3);
      expect(getDoc(v)).toBe("### title");
    });

    it("已是 H1 → 切换到 H2 替换前缀", () => {
      const v = makeView("# title");
      setSelection(v, 0);
      setHeading(v, 2);
      expect(getDoc(v)).toBe("## title");
    });

    it("level=0 取消标题", () => {
      const v = makeView("### heading");
      setSelection(v, 0);
      setHeading(v, 0);
      expect(getDoc(v)).toBe("heading");
    });

    it("多行选区：全部添加前缀", () => {
      const v = makeView("line1\nline2\nline3");
      // "line1\nline2\nline3" 长度 17，选第二行开头到末尾
      setSelection(v, 6, 17);
      setHeading(v, 2);
      const lines = getDoc(v).split("\n");
      expect(lines[0]).toBe("line1");
      expect(lines[1]).toBe("## line2");
      expect(lines[2]).toBe("## line3");
    });
  });

  describe("toggleList", () => {
    it("无序列表：添加 - 前缀", () => {
      const v = makeView("item");
      setSelection(v, 0);
      toggleList(v, "unordered");
      expect(getDoc(v)).toBe("- item");
    });

    it("无序列表：已是 - 前缀则取消", () => {
      const v = makeView("- item");
      setSelection(v, 0);
      toggleList(v, "unordered");
      expect(getDoc(v)).toBe("item");
    });

    it("有序列表：添加 1. 前缀", () => {
      const v = makeView("first");
      setSelection(v, 0);
      toggleList(v, "ordered");
      expect(getDoc(v)).toBe("1. first");
    });

    it("任务列表：添加 - [ ] 前缀", () => {
      const v = makeView("todo");
      setSelection(v, 0);
      toggleList(v, "task");
      expect(getDoc(v)).toBe("- [ ] todo");
    });

    it("任务列表：已是任务项则取消", () => {
      const v = makeView("- [x] done");
      setSelection(v, 0);
      toggleList(v, "task");
      expect(getDoc(v)).toBe("done");
    });
  });

  describe("toggleBlockquote", () => {
    it("添加 > 前缀", () => {
      const v = makeView("quote me");
      setSelection(v, 0);
      toggleBlockquote(v);
      expect(getDoc(v)).toBe("> quote me");
    });

    it("已是引用则取消", () => {
      const v = makeView("> quoted");
      setSelection(v, 0);
      toggleBlockquote(v);
      expect(getDoc(v)).toBe("quoted");
    });

    it("多行选区全部添加前缀", () => {
      const v = makeView("line1\nline2");
      // "line1\nline2" 长度 11，选 0-11
      setSelection(v, 0, 11);
      toggleBlockquote(v);
      const lines = getDoc(v).split("\n");
      expect(lines[0]).toBe("> line1");
      expect(lines[1]).toBe("> line2");
    });
  });

  describe("toggleCodeBlock", () => {
    it("包裹选区为代码块", () => {
      const v = makeView("code here");
      setSelection(v, 0, 9);
      toggleCodeBlock(v);
      expect(getDoc(v)).toBe("```\ncode here\n```");
    });

    it("空选区也包裹", () => {
      const v = makeView("ab");
      setSelection(v, 0, 2);
      toggleCodeBlock(v);
      expect(getDoc(v)).toBe("```\nab\n```");
    });
  });

  describe("insertHorizontalRule", () => {
    it("在空行后插入分隔线", () => {
      const v = makeView("");
      setSelection(v, 0);
      insertHorizontalRule(v);
      expect(getDoc(v)).toBe("\n---\n");
    });

    it("在有内容的行后插入", () => {
      const v = makeView("hello");
      setSelection(v, 5);
      insertHorizontalRule(v);
      expect(getDoc(v)).toBe("hello\n\n---\n");
    });
  });

  describe("insertTable", () => {
    it("插入 2x3 表格模板", () => {
      const v = makeView("");
      setSelection(v, 0);
      insertTable(v, 2, 3);
      const doc = getDoc(v);
      // 表头 3 列
      expect(doc).toContain("| 标题 | 标题 | 标题 |");
      // 分隔行 3 列
      expect(doc).toContain("| --- | --- | --- |");
      // 2 数据行
      const lines = doc.split("\n");
      const dataRows = lines.filter((l) => l.startsWith("|  |") || l === "|  |  |  |");
      expect(dataRows.length).toBeGreaterThanOrEqual(2);
    });

    it("至少 1 行 1 列", () => {
      const v = makeView("");
      setSelection(v, 0);
      insertTable(v, 0, 0);
      expect(getDoc(v)).toContain("| 标题 |");
      expect(getDoc(v)).toContain("| --- |");
    });
  });

  describe("createTestView", () => {
    it("创建带扩展的 view", () => {
      const v = createTestView("test");
      expect(getDoc(v)).toBe("test");
    });
  });

describe("toggleInline", () => {
  it("空选区：插入标记对，光标在中间", () => {
    const v = makeView("ab");
    setSelection(v, 1);
    toggleInline(v, "**");
    expect(getDoc(v)).toBe("a****b");
  });

  it("有选区：用 ** 包围", () => {
    const v = makeView("hello");
    setSelection(v, 0, 5);
    toggleInline(v, "**");
    expect(getDoc(v)).toBe("**hello**");
  });

  it("选区自身被 ** 包围：移除标记", () => {
    const v = makeView("**hello**");
    setSelection(v, 0, 9);
    toggleInline(v, "**");
    expect(getDoc(v)).toBe("hello");
  });

  it("选区两侧紧邻 **：移除标记", () => {
    const v = makeView("**hello**");
    setSelection(v, 2, 7);
    toggleInline(v, "**");
    expect(getDoc(v)).toBe("hello");
  });

  it("行内代码：用 ` 包围", () => {
    const v = makeView("code");
    setSelection(v, 0, 4);
    toggleInline(v, "`");
    expect(getDoc(v)).toBe("`code`");
  });
});

describe("insertLink", () => {
  it("插入 [text](url)", () => {
    const v = makeView("hello");
    setSelection(v, 0, 5);
    insertLink(v, "https://example.com", "hello");
    expect(getDoc(v)).toBe("[hello](https://example.com)");
  });
});

describe("insertImage", () => {
  it("插入 ![alt](url)", () => {
    const v = makeView("");
    setSelection(v, 0);
    insertImage(v, "/img.png", "fig");
    expect(getDoc(v)).toBe("![fig](/img.png)");
  });
});

describe("getActiveFormats", () => {
  it("光标在 **bold** 内 → bold 激活", () => {
    const v = makeView("**bold**");
    setSelection(v, 3);
    expect(getActiveFormats(v).has("bold")).toBe(true);
  });

  it("光标在 ## 标题行 → h2 激活", () => {
    const v = makeView("## title");
    setSelection(v, 3);
    const a = getActiveFormats(v);
    expect(a.has("h2")).toBe(true);
    expect(a.has("h1")).toBe(false);
  });

  it("光标在 - [ ] 任务行 → task-list 激活", () => {
    const v = makeView("- [ ] todo");
    setSelection(v, 5);
    expect(getActiveFormats(v).has("task-list")).toBe(true);
  });

  it("光标在 > 引用行 → blockquote 激活", () => {
    const v = makeView("> quote");
    setSelection(v, 3);
    expect(getActiveFormats(v).has("blockquote")).toBe(true);
  });

  it("普通文本无激活格式", () => {
    const v = makeView("plain text");
    setSelection(v, 3);
    expect(getActiveFormats(v).size).toBe(0);
  });
});

});
