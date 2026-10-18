import { describe, it, expect } from "vitest";
import { resolveInternalMarkdownLink } from "./internalLink";

/**
 * #435：预览内 .md 链接的解析统一走 utils/path。
 * 重点回归：已含盘符的绝对路径不能被加前导 `/`（旧实现得到 `/C:/ws/b.md`）。
 */
describe("resolveInternalMarkdownLink", () => {
  const context = { filePath: "C:/ws/docs/a.md", workspacePath: "C:/ws" };

  it("相对链接以当前文件所在目录为基准", () => {
    expect(resolveInternalMarkdownLink("b.md", context)).toBe("C:/ws/docs/b.md");
    expect(resolveInternalMarkdownLink("../c.md", context)).toBe("C:/ws/c.md");
  });

  it("去掉锚点与查询后再解析", () => {
    expect(resolveInternalMarkdownLink("b.md#section", context)).toBe("C:/ws/docs/b.md");
    expect(resolveInternalMarkdownLink("./b.md?x=1", context)).toBe("C:/ws/docs/b.md");
  });

  it("绝对路径原样返回，不加前导斜杠（回归）", () => {
    expect(resolveInternalMarkdownLink("C:/ws/b.md", context)).toBe("C:/ws/b.md");
    expect(resolveInternalMarkdownLink("/ws/b.md", context)).toBe("/ws/b.md");
  });

  it("没有当前文件时以工作区根为基准", () => {
    expect(
      resolveInternalMarkdownLink("notes/b.md", { filePath: null, workspacePath: "C:/ws" })
    ).toBe("C:/ws/notes/b.md");
  });

  it("Windows 反斜杠路径", () => {
    expect(
      resolveInternalMarkdownLink("sub\\b.md", {
        filePath: "C:\\ws\\docs\\a.md",
        workspacePath: null,
      })
    ).toBe("C:/ws/docs/sub/b.md");
  });

  it("外部 URL / 锚点 / 非 Markdown 扩展名返回 null", () => {
    expect(resolveInternalMarkdownLink("https://example.com", context)).toBeNull();
    expect(resolveInternalMarkdownLink("#section", context)).toBeNull();
    expect(resolveInternalMarkdownLink("image.png", context)).toBeNull();
  });

  it("没有任何基准目录时返回 null", () => {
    expect(resolveInternalMarkdownLink("b.md", {})).toBeNull();
  });
});
