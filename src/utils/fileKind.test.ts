/**
 * 文件类型判定测试（图片部分由 useImagePaste.test.ts 迁入 —— 扩展名判定统一在
 * utils/fileKind，issue #151 把重复的 isImageExt 删掉后测试也跟着归位）
 */
import { describe, it, expect } from "vitest";
import { isImageFile } from "./fileKind";

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
