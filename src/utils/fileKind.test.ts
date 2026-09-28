/**
 * 文件类型判定测试（图片部分由 useImagePaste.test.ts 迁入 —— 扩展名判定统一在
 * utils/fileKind，issue #151 把重复的 isImageExt 删掉后测试也跟着归位）
 */
import { describe, it, expect } from "vitest";
import {
  isImageFile,
  isEditableTextFile,
  isLargeExtensionlessFile,
  isMarkdownFile,
  isHtmlFile,
  isDocumentFile,
  isSourceOnlyFile,
  EXTENSIONLESS_TEXT_MAX_SIZE,
} from "./fileKind";

describe("isMarkdownFile", () => {
  it("识别 markdown 扩展名（md/markdown/mdown/mkd，大小写不敏感）", () => {
    expect(isMarkdownFile("a.md")).toBe(true);
    expect(isMarkdownFile("a.markdown")).toBe(true);
    expect(isMarkdownFile("a.mdown")).toBe(true);
    expect(isMarkdownFile("a.mkd")).toBe(true);
    expect(isMarkdownFile("README.MD")).toBe(true);
  });

  it("接受路径，而不只是文件名", () => {
    expect(isMarkdownFile("/ws/docs/readme.mkd")).toBe(true);
    expect(isMarkdownFile("C:\\ws\\docs\\readme.md")).toBe(true);
  });

  it("非 markdown 返回 false（含 html 与其它文本）", () => {
    expect(isMarkdownFile("a.html")).toBe(false);
    expect(isMarkdownFile("a.txt")).toBe(false);
    expect(isMarkdownFile("noext")).toBe(false);
  });
});

describe("isHtmlFile", () => {
  it("只认 html / htm（大小写不敏感，接受路径）", () => {
    expect(isHtmlFile("a.html")).toBe(true);
    expect(isHtmlFile("a.htm")).toBe(true);
    expect(isHtmlFile("/ws/page.HTML")).toBe(true);
  });

  it("非 html 返回 false", () => {
    expect(isHtmlFile("a.md")).toBe(false);
    expect(isHtmlFile("a.vue")).toBe(false);
    expect(isHtmlFile("a.xhtml")).toBe(false);
    expect(isHtmlFile("noext")).toBe(false);
  });
});

describe("isDocumentFile / isSourceOnlyFile", () => {
  it("markdown 与 html 属文档类：可参与预览/大纲，不是源码-only", () => {
    for (const name of ["a.md", "a.markdown", "a.html", "a.htm", "README.MD"]) {
      expect(isDocumentFile(name)).toBe(true);
      expect(isSourceOnlyFile(name)).toBe(false);
    }
  });

  it("其它文本/代码/无后缀一律源码-only：强制源码模式，不挂预览卡", () => {
    for (const name of ["a.txt", "a.json", "a.vue", "a.py", "Makefile", ".gitignore"]) {
      expect(isDocumentFile(name)).toBe(false);
      expect(isSourceOnlyFile(name)).toBe(true);
    }
  });

  it("两者互斥（文档类 ⟺ 非源码-only）", () => {
    for (const name of ["a.md", "a.html", "a.txt", "a.pdf", "noext"]) {
      expect(isSourceOnlyFile(name)).toBe(!isDocumentFile(name));
    }
  });
});

describe("isImageFile", () => {
  it("识别常见图片扩展名", () => {
    expect(isImageFile("a.png")).toBe(true);
    expect(isImageFile("a.jpg")).toBe(true);
    expect(isImageFile("a.jpeg")).toBe(true);
    expect(isImageFile("a.gif")).toBe(true);
    expect(isImageFile("a.webp")).toBe(true);
    expect(isImageFile("a.bmp")).toBe(true);
    expect(isImageFile("a.svg")).toBe(true);
  });

  it("大小写不敏感", () => {
    expect(isImageFile("PHOTO.PNG")).toBe(true);
    expect(isImageFile("Photo.Jpg")).toBe(true);
  });

  it("接受路径而不只是文件名", () => {
    expect(isImageFile("/ws/assets/images/pic.png")).toBe(true);
    expect(isImageFile("C:\\ws\\assets\\pic.BMP")).toBe(true);
  });

  it("非图片扩展名返回 false", () => {
    expect(isImageFile("a.md")).toBe(false);
    expect(isImageFile("a.txt")).toBe(false);
    expect(isImageFile("a.pdf")).toBe(false);
    expect(isImageFile("noext")).toBe(false);
  });
});

describe("isEditableTextFile", () => {
  it("白名单后缀 → 可按文本打开（含 markdown / html）", () => {
    expect(isEditableTextFile("a.md")).toBe(true);
    expect(isEditableTextFile("a.txt")).toBe(true);
    expect(isEditableTextFile("a.html")).toBe(true);
    expect(isEditableTextFile("a.py")).toBe(true);
    expect(isEditableTextFile("A.JSON")).toBe(true);
  });

  it("白名单外的后缀 → 不按文本打开", () => {
    expect(isEditableTextFile("a.pdf")).toBe(false);
    expect(isEditableTextFile("a.zip")).toBe(false);
    expect(isEditableTextFile("a.docx")).toBe(false);
    expect(isEditableTextFile("a.exe")).toBe(false);
  });

  it("无后缀 → 一律允许尝试（#308：大小不再是门槛）", () => {
    expect(isEditableTextFile("Makefile")).toBe(true);
    expect(isEditableTextFile("/ws/Dockerfile")).toBe(true);
    // 点开头的隐藏文件按无后缀处理（extname(".gitignore") === ""）
    expect(isEditableTextFile(".gitignore")).toBe(true);
  });
});

describe("isLargeExtensionlessFile", () => {
  it("无后缀且 ≥ 阈值 → true（恰好等于阈值也算）", () => {
    expect(isLargeExtensionlessFile("build-log", EXTENSIONLESS_TEXT_MAX_SIZE)).toBe(true);
    expect(isLargeExtensionlessFile("build-log", EXTENSIONLESS_TEXT_MAX_SIZE + 1)).toBe(true);
  });

  it("无后缀且 < 阈值 → false", () => {
    expect(isLargeExtensionlessFile("Makefile", 0)).toBe(false);
    expect(isLargeExtensionlessFile("Makefile", EXTENSIONLESS_TEXT_MAX_SIZE - 1)).toBe(false);
  });

  it("无后缀但大小未知 → false（不拦，交给读取失败兜底）", () => {
    expect(isLargeExtensionlessFile("Makefile")).toBe(false);
  });

  it("有后缀一律 false（大文件保护只针对无后缀；.log 等大文件行为不变）", () => {
    expect(isLargeExtensionlessFile("huge.log", EXTENSIONLESS_TEXT_MAX_SIZE * 100)).toBe(false);
    expect(isLargeExtensionlessFile("huge.txt", EXTENSIONLESS_TEXT_MAX_SIZE * 100)).toBe(false);
  });
});
