/**
 * textStats 单元测试（T2.1 状态栏字数 / 字符数口径）
 */
import { describe, it, expect } from "vitest";
import { countChars, countWords } from "./textStats";

describe("textStats - countChars", () => {
  it("不含空白字符的字符总数", () => {
    expect(countChars("中文文档 hello world")).toBe(14);
  });

  it("跳过空格 / Tab / 换行", () => {
    expect(countChars("a b\tc\nd")).toBe(4);
    expect(countChars("  \n\t ")).toBe(0);
  });

  it("空串为 0", () => {
    expect(countChars("")).toBe(0);
  });

  it("emoji 按码点计 1", () => {
    expect(countChars("🙂")).toBe(1);
    expect(countChars("a🙂b")).toBe(3);
  });
});

describe("textStats - countWords", () => {
  it("纯 CJK 逐字", () => {
    expect(countWords("中文文档")).toBe(4);
  });

  it("纯拉丁逐词", () => {
    expect(countWords("hello world")).toBe(2);
  });

  it("中英混排：4 个 CJK 字 + 2 个英文词", () => {
    expect(countWords("中文文档 hello world")).toBe(6);
  });

  it("标点与换行分隔词", () => {
    expect(countWords("a,b\nc")).toBe(3);
    expect(countWords("hello-world")).toBe(2);
  });

  it("数字连续串按 1 个词", () => {
    expect(countWords("2026 09")).toBe(2);
    expect(countWords("v1.2")).toBe(2);
  });

  it("空白与标点不计词", () => {
    expect(countWords("   ")).toBe(0);
    expect(countWords("！！！。，")).toBe(0);
    expect(countWords("")).toBe(0);
  });

  it("emoji 不计词，但相邻字母仍成词", () => {
    expect(countWords("🙂")).toBe(0);
    expect(countWords("a🙂b")).toBe(2);
  });
});
