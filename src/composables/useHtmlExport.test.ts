import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

import { getMarkdownRenderer, getCurrentFilePath, setCurrentFilePath } from "./useMarkdownRenderer";
import { exportHtml } from "./useHtmlExport";

/**
 * #434：导出不得改写预览正在使用的模块级状态。
 */
describe("exportHtml 与预览的隔离（#434）", () => {
  it("导出不改写 WYSIWYG 的文件路径", async () => {
    setCurrentFilePath("/ws/current.md");

    await exportHtml({
      source: "# x",
      theme: "murasaki",
      workspacePath: "/ws",
      filePath: "/ws/other.md",
    });

    expect(getCurrentFilePath()).toBe("/ws/current.md");
    setCurrentFilePath(null);
  });

  it("导出不污染预览的 Shiki 主题", async () => {
    const md = getMarkdownRenderer();
    const original = md.getShikiTheme();
    md.setShikiTheme("github-dark");

    await exportHtml({
      source: "# no code fence",
      theme: "academic",
      workspacePath: null,
      filePath: null,
    });

    expect(md.getShikiTheme()).toBe("github-dark");
    md.setShikiTheme(original);
  });
});
