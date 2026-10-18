import { describe, it, expect, vi } from "vitest";

// 与 utils/imagePath.test.ts 同口径：固定 convertFileSrc，避免平台差异
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

import {
  getMarkdownRenderer,
  getCurrentFilePath,
  setCurrentFilePath,
} from "./useMarkdownRenderer";
import { exportHtml } from "./useHtmlExport";

/**
 * #434：渲染上下文（filePath / frontMatter / theme）必须是显式参数与返回值，
 * 导出与预览并发时不能串用彼此的文档或主题。
 */
describe("useMarkdownRenderer 渲染上下文（#434）", () => {
  it("每次渲染返回自己的 front-matter，不残留上一篇的 YAML", () => {
    const md = getMarkdownRenderer();

    const a = md.render("---\ntitle: A\n---\n\n# A", { filePath: "/ws/a.md" });
    const b = md.render("---\ntitle: B\n---\n\n# B", { filePath: "/ws/b.md" });
    const c = md.render("# 没有 front-matter", { filePath: "/ws/c.md" });

    expect(a.frontMatter).toContain("title: A");
    expect(b.frontMatter).toContain("title: B");
    expect(c.frontMatter).toBe("");
    expect(a.html).not.toContain("title: B");
  });

  it("相对图片按各自的 filePath 解析，互不影响", () => {
    const md = getMarkdownRenderer();

    const a = md.render("![](assets/p.png)", { filePath: "/ws/a/doc.md" });
    const b = md.render("![](assets/p.png)", { filePath: "/ws/b/doc.md" });

    expect(a.html).toContain("/ws/a/assets/p.png");
    expect(a.html).not.toContain("/ws/b/assets/p.png");
    expect(b.html).toContain("/ws/b/assets/p.png");
  });

  it("导出不改写 WYSIWYG 的文件路径", async () => {
    setCurrentFilePath("/ws/current.md");

    await exportHtml({
      source: "# x",
      theme: "murasaki",
      workspacePath: "/ws",
      filePath: "/ws/other.md",
    });

    expect(getCurrentFilePath()).toBe("/ws/current.md");
  });

  it("导出不污染预览的 Shiki 主题", async () => {
    const md = getMarkdownRenderer();
    md.setShikiTheme("github-dark");

    await exportHtml({
      source: "# no code fence",
      theme: "academic",
      workspacePath: null,
      filePath: null,
    });

    expect(md.getShikiTheme()).toBe("github-dark");
  });
});
