import { describe, expect, it } from "vitest";
import { findMarkdownLinkAt } from "./linkClick";

describe("findMarkdownLinkAt（#505）", () => {
  it("定位普通行内链接，位置覆盖方括号与圆括号", () => {
    const doc = "前文 [文档](https://example.com/a) 后文";
    const from = doc.indexOf("[文档]");

    const link = findMarkdownLinkAt(doc, from + 1);

    expect(link).not.toBeNull();
    expect(link!.url).toBe("https://example.com/a");
    expect(doc.slice(link!.from, link!.to)).toBe("[文档](https://example.com/a)");
  });

  it("点在目标地址中间也命中同一个链接", () => {
    const doc = "见 [a](notes.md) 完";
    const pos = doc.indexOf("notes.md") + 2;

    const link = findMarkdownLinkAt(doc, pos);

    expect(link!.url).toBe("notes.md");
  });

  it("链接之外返回 null", () => {
    const doc = "前文 [文档](https://example.com) 后文";

    expect(findMarkdownLinkAt(doc, 0)).toBeNull();
    expect(findMarkdownLinkAt(doc, doc.length - 1)).toBeNull();
  });

  it("图片语法不算链接（点击图片不跳转）", () => {
    const doc = "![图](pic.png)";
    const pos = doc.indexOf("pic.png");

    expect(findMarkdownLinkAt(doc, pos)).toBeNull();
  });

  it("识别尖括号包裹的地址与可选 title", () => {
    const angled = "见 [a](<my file.md>) 完";
    expect(findMarkdownLinkAt(angled, angled.indexOf("my file")!)?.url).toBe("my file.md");

    const titled = '见 [a](https://example.com "标题") 完';
    expect(findMarkdownLinkAt(titled, titled.indexOf("example"))?.url).toBe("https://example.com");
  });

  it("只匹配当前行：同一行有多个链接时取覆盖当前位置的那个", () => {
    const doc = "[一](a.md) 和 [二](b.md)";
    const second = doc.indexOf("[二]");

    expect(findMarkdownLinkAt(doc, 0)!.url).toBe("a.md");
    expect(findMarkdownLinkAt(doc, second + 1)!.url).toBe("b.md");
  });

  it("越界位置返回 null", () => {
    expect(findMarkdownLinkAt("[a](b.md)", -1)).toBeNull();
    expect(findMarkdownLinkAt("[a](b.md)", 999)).toBeNull();
  });
});
