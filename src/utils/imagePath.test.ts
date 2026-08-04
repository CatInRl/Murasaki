/**
 * 图片路径解析测试（ADR-0015 / issue #118）
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock convertFileSrc 以保证测试可重现
// 真实实现会根据 navigator.userAgent 返回不同 URL 格式（Windows vs Unix）
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

import {
  resolveImageSrc,
  isExternalUrl,
  isDataUrl,
  isAbsolutePath,
} from "./imagePath";

describe("utils/imagePath", () => {
  describe("isExternalUrl", () => {
    it("识别 http/https URL", () => {
      expect(isExternalUrl("https://example.com/img.png")).toBe(true);
      expect(isExternalUrl("http://example.com/img.png")).toBe(true);
    });
    it("识别 ftp/mailto/tel/file 协议", () => {
      expect(isExternalUrl("ftp://example.com/file")).toBe(true);
      expect(isExternalUrl("mailto:test@example.com")).toBe(true);
      expect(isExternalUrl("tel:+8613800000000")).toBe(true);
      expect(isExternalUrl("file:///C:/path/file.txt")).toBe(true);
    });
    it("非 URL 返回 false", () => {
      expect(isExternalUrl("assets/img.png")).toBe(false);
      expect(isExternalUrl("C:\\images\\img.png")).toBe(false);
      expect(isExternalUrl("/home/user/img.png")).toBe(false);
      expect(isExternalUrl("data:image/png;base64,...")).toBe(false);
    });
  });

  describe("isDataUrl", () => {
    it("识别 data URL", () => {
      expect(isDataUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
      expect(isDataUrl("data:text/plain,hello")).toBe(true);
    });
    it("非 data URL 返回 false", () => {
      expect(isDataUrl("https://example.com/img.png")).toBe(false);
      expect(isDataUrl("assets/img.png")).toBe(false);
    });
  });

  describe("isAbsolutePath", () => {
    it("识别 Windows 绝对路径", () => {
      expect(isAbsolutePath("C:\\images\\img.png")).toBe(true);
      expect(isAbsolutePath("C:/images/img.png")).toBe(true);
      expect(isAbsolutePath("D:/photos/test.jpg")).toBe(true);
    });
    it("识别 Unix 绝对路径", () => {
      expect(isAbsolutePath("/home/user/img.png")).toBe(true);
      expect(isAbsolutePath("/var/images/test.jpg")).toBe(true);
    });
    it("相对路径返回 false", () => {
      expect(isAbsolutePath("assets/img.png")).toBe(false);
      expect(isAbsolutePath("./img.png")).toBe(false);
      expect(isAbsolutePath("../images/img.png")).toBe(false);
    });
  });

  describe("resolveImageSrc", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("http(s) URL 原样保留", () => {
      const url = "https://example.com/img.png";
      expect(resolveImageSrc(url, "C:/docs/file.md")).toBe(url);
    });

    it("Base64 data URL 原样保留", () => {
      const data = "data:image/png;base64,iVBORw0KGgo=";
      expect(resolveImageSrc(data, "C:/docs/file.md")).toBe(data);
    });

    it("Windows 绝对路径 → convertFileSrc 转换", () => {
      const result = resolveImageSrc("C:/images/img.png", "C:/docs/file.md");
      expect(result).toBe("asset://localhost/C:/images/img.png");
    });

    it("Windows 绝对路径（反斜杠）→ 规范化后转换", () => {
      const result = resolveImageSrc("C:\\images\\img.png", "C:/docs/file.md");
      expect(result).toBe("asset://localhost/C:/images/img.png");
    });

    it("Unix 绝对路径 → convertFileSrc 转换", () => {
      const result = resolveImageSrc("/home/user/img.png", "/docs/file.md");
      expect(result).toBe("asset://localhost//home/user/img.png");
    });

    it("相对路径基于当前文件目录解析", () => {
      // currentFilePath: C:/docs/file.md → 基准目录 C:/docs
      // src: assets/img.png → 解析为 C:/docs/assets/img.png
      const result = resolveImageSrc("assets/img.png", "C:/docs/file.md");
      expect(result).toBe("asset://localhost/C:/docs/assets/img.png");
    });

    it("相对路径含 ../ 上级目录", () => {
      // currentFilePath: C:/docs/sub/file.md → 基准目录 C:/docs/sub
      // src: ../images/img.png → 解析为 C:/docs/images/img.png
      const result = resolveImageSrc("../images/img.png", "C:/docs/sub/file.md");
      expect(result).toBe("asset://localhost/C:/docs/images/img.png");
    });

    it("相对路径含 ./ 当前目录", () => {
      const result = resolveImageSrc("./img.png", "C:/docs/file.md");
      expect(result).toBe("asset://localhost/C:/docs/img.png");
    });

    it("currentFilePath 为 null 时，相对路径原样返回（无法解析）", () => {
      const src = "assets/img.png";
      expect(resolveImageSrc(src, null)).toBe(src);
    });

    it("currentFilePath 为空字符串时，相对路径原样返回", () => {
      const src = "assets/img.png";
      expect(resolveImageSrc(src, "")).toBe(src);
    });

    it("空 src 原样返回", () => {
      expect(resolveImageSrc("", "C:/docs/file.md")).toBe("");
    });

    it("Windows 反斜杠 currentFilePath 也能正确解析", () => {
      // currentFilePath: C:\docs\file.md → 规范化为 C:/docs/file.md → dirname: C:/docs
      // src: assets/img.png → 解析为 C:/docs/assets/img.png
      const result = resolveImageSrc("assets/img.png", "C:\\docs\\file.md");
      expect(result).toBe("asset://localhost/C:/docs/assets/img.png");
    });

    it("markdown-it URL 编码后的 Windows 绝对路径（%5C = 反斜杠）", () => {
      // markdown-it 把 `C:\images\img.png` 解析为 `C:%5Cimages%5Cimg.png`
      // resolveImageSrc 应先 decodeURIComponent 还原为 `C:\images\img.png`，再转换
      const encoded = "C:%5Cimages%5Cimg.png";
      const result = resolveImageSrc(encoded, "C:/docs/file.md");
      expect(result).toBe("asset://localhost/C:/images/img.png");
    });

    it("markdown-it URL 编码后的 Windows 绝对路径 + 反斜杠 currentFilePath", () => {
      // 同时覆盖：encoded src + 反斜杠 currentFilePath
      const encoded = "D:%5Cphotos%5Ctest.jpg";
      const result = resolveImageSrc(encoded, "D:\\docs\\file.md");
      expect(result).toBe("asset://localhost/D:/photos/test.jpg");
    });

    it("无效 % 序列不抛出（保留原值走相对路径分支）", () => {
      // 含 % 但非合法 URL 编码（如 %zz）→ decodeURIComponent 抛出 → 保留原值
      // 走相对路径分支解析
      const result = resolveImageSrc("invalid%zzpath.png", "C:/docs/file.md");
      expect(result).toBe("asset://localhost/C:/docs/invalid%zzpath.png");
    });
  });
});
