import { describe, it, expect } from "vitest";
import { __test__ } from "./useImagePaste";

const { relativePath, isImageExt } = __test__;

describe("useImagePaste utilities", () => {
  describe("isImageExt", () => {
    it("识别常见图片扩展名", () => {
      expect(isImageExt("png")).toBe(true);
      expect(isImageExt("jpg")).toBe(true);
      expect(isImageExt("jpeg")).toBe(true);
      expect(isImageExt("gif")).toBe(true);
      expect(isImageExt("webp")).toBe(true);
      expect(isImageExt("bmp")).toBe(true);
      expect(isImageExt("svg")).toBe(true);
    });

    it("大小写不敏感", () => {
      expect(isImageExt("PNG")).toBe(true);
      expect(isImageExt("Jpg")).toBe(true);
    });

    it("非图片扩展名返回 false", () => {
      expect(isImageExt("md")).toBe(false);
      expect(isImageExt("txt")).toBe(false);
      expect(isImageExt("pdf")).toBe(false);
      expect(isImageExt("")).toBe(false);
    });
  });

  describe("relativePath", () => {
    it("同目录文件", () => {
      const from = "/workspace/docs/intro.md";
      const to = "/workspace/docs/assets/img.png";
      const rel = relativePath(from, to);
      expect(rel).toBe("assets/img.png");
    });

    it("父目录中的文件", () => {
      const from = "/workspace/docs/sub/page.md";
      const to = "/workspace/docs/assets/img.png";
      const rel = relativePath(from, to);
      expect(rel).toBe("../assets/img.png");
    });

    it("跨多级目录", () => {
      const from = "/workspace/a/b/c/file.md";
      const to = "/workspace/x/y/img.png";
      const rel = relativePath(from, to);
      expect(rel).toBe("../../../x/y/img.png");
    });

    it("Windows 风格路径", () => {
      const from = "C:\\workspace\\docs\\intro.md";
      const to = "C:\\workspace\\docs\\assets\\img.png";
      const rel = relativePath(from, to);
      expect(rel).toBe("assets/img.png");
    });

    it("同一路径返回文件名", () => {
      const from = "/workspace/docs/intro.md";
      const to = "/workspace/docs/intro.md";
      const rel = relativePath(from, to);
      expect(rel).toBe("intro.md");
    });

    it("根目录下文件", () => {
      const from = "/workspace/root.md";
      const to = "/workspace/assets/img.png";
      const rel = relativePath(from, to);
      expect(rel).toBe("assets/img.png");
    });
  });
});
