/**
 * 文件类型判定测试（图片部分由 useImagePaste.test.ts 迁入 —— 扩展名判定统一在
 * utils/fileKind，issue #151 把重复的 isImageExt 删掉后测试也跟着归位）
 */
import { describe, it, expect } from "vitest";
import {
  isImageFile,
  isEditableTextFile,
  isLargeExtensionlessFile,
  EXTENSIONLESS_TEXT_MAX_SIZE,
} from "./fileKind";

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
