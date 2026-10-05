/**
 * 文件树拖入编辑器的分流判定测试（issue #379）
 *
 * 修复前：TreeNode 对所有文件统一携带拖拽 MIME，EditorPane 的 onEditorDrop
 * 不区分类型一律走图片插入 —— 拖 notes.md 进编辑器会插入 `![](notes.md)`。
 * 分流口径与 ADR-0020 的打开矩阵一致：
 * - 图片 → 插入相对路径引用（现状保留）
 * - 应用打得开（markdown / 白名单文本 / 无后缀）→ 打开为 tab
 * - 应用打不开（pdf / zip / exe …）→ 系统默认程序兜底（#307 出口）
 * - 目录 → 忽略（目录拖入编辑器没有明确意图，且不能静默改工作区）
 */
import { describe, it, expect } from "vitest";
import { classifyTreeDrop } from "./treeDrop";

describe("classifyTreeDrop（#379）", () => {
  it("图片文件 → 插入图片引用（现状保留）", () => {
    for (const name of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.bmp", "g.svg"]) {
      expect(classifyTreeDrop("file", name)).toBe("insert-image");
    }
    expect(classifyTreeDrop("file", "C:/ws/assets/pic.PNG")).toBe("insert-image");
  });

  it("markdown 文件 → 打开为 tab（不再插入图片语法）", () => {
    for (const name of ["notes.md", "README.MD", "a.markdown", "b.mdown", "c.mkd"]) {
      expect(classifyTreeDrop("file", name)).toBe("open-tab");
    }
    expect(classifyTreeDrop("file", "C:/ws/notes.md")).toBe("open-tab");
  });

  it("白名单文本/代码文件 → 打开为 tab", () => {
    for (const name of ["a.txt", "b.json", "c.py", "d.rs", "e.css", "log.txt", "data.csv"]) {
      expect(classifyTreeDrop("file", name)).toBe("open-tab");
    }
  });

  it("无后缀文件 → 打开为 tab（#308：无后缀一律允许尝试）", () => {
    expect(classifyTreeDrop("file", "Makefile")).toBe("open-tab");
    expect(classifyTreeDrop("file", "C:/ws/LICENSE")).toBe("open-tab");
  });

  it("应用打不开的文件 → 系统默认程序兜底（#307 出口）", () => {
    for (const name of ["manual.pdf", "archive.zip", "setup.exe", "report.docx", "video.mp4"]) {
      expect(classifyTreeDrop("file", name)).toBe("system-open");
    }
  });

  it("目录 → 忽略（即使后缀长得像文件也不能误判）", () => {
    expect(classifyTreeDrop("directory", "assets")).toBe("ignore");
    expect(classifyTreeDrop("directory", "weird.folder.md")).toBe("ignore");
    expect(classifyTreeDrop("directory", "C:/ws/docs")).toBe("ignore");
  });
});
