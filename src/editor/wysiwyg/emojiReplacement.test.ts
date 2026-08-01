/**
 * T6.1 (issue #99) — Emoji 短代码源码替换纯函数测试。
 *
 * 规则（spec）：
 * - WYSIWYG 模式下，光标离开当前段时，段内 `:shortcode:` 被替换为实际 emoji 字符写入源码。
 * - 复用 markdown-it-emoji 的 shortcode → unicode 映射。
 * - 代码范围（代码块 / 行内代码）内的 `:shortcode:` 不替换。
 * - 未知 shortcode 不替换（保持原样）。
 */
import { describe, it, expect } from "vitest";
import { findEmojiShortcodesInRange } from "./emojiReplacement";

describe("findEmojiShortcodesInRange", () => {
  it("段内单个 :smile: 返回一个替换项", () => {
    const doc = "Hello :smile: world";
    const r = findEmojiShortcodesInRange(doc, 0, doc.length, []);
    expect(r).toHaveLength(1);
    expect(r[0].shortcode).toBe("smile");
    expect(r[0].emoji).toBe("😄");
    expect(doc.slice(r[0].from, r[0].to)).toBe(":smile:");
  });

  it("段内多个 shortcode 全部识别", () => {
    const doc = ":smile: :heart: :rocket:";
    const r = findEmojiShortcodesInRange(doc, 0, doc.length, []);
    expect(r).toHaveLength(3);
    expect(r.map((x) => x.shortcode)).toEqual(["smile", "heart", "rocket"]);
  });

  it("未知 shortcode 不返回", () => {
    const doc = ":smile: :not_a_real_emoji_xyz: :heart:";
    const r = findEmojiShortcodesInRange(doc, 0, doc.length, []);
    expect(r).toHaveLength(2);
    expect(r.map((x) => x.shortcode)).toEqual(["smile", "heart"]);
  });

  it("带 +/- 的 shortcode（:+1: / :-1:）可识别", () => {
    const doc = ":+1: and :-1:";
    const r = findEmojiShortcodesInRange(doc, 0, doc.length, []);
    expect(r).toHaveLength(2);
    expect(r[0].shortcode).toBe("+1");
    expect(r[1].shortcode).toBe("-1");
  });

  it("只返回落在 [from, to] 范围内的匹配", () => {
    // :smile: 在 [0,7)，:heart: 在 [8,15)，:rocket: 在 [16,23)
    // 段范围 [7, 16) 仅完整覆盖 :heart:
    const doc = ":smile: :heart: :rocket:";
    const r = findEmojiShortcodesInRange(doc, 7, 16, []);
    expect(r).toHaveLength(1);
    expect(r[0].shortcode).toBe("heart");
  });

  it("代码范围内的 shortcode 被跳过", () => {
    // 假设 [6, 13) 是行内代码范围，覆盖 ":heart:"
    const doc = ":smile: :heart: :rocket:";
    const r = findEmojiShortcodesInRange(doc, 0, doc.length, [{ from: 7, to: 15 }]);
    expect(r.map((x) => x.shortcode)).toEqual(["smile", "rocket"]);
  });

  it("完全在代码块内的多个 shortcode 全部跳过", () => {
    const doc = ":smile:\n\n```\n:heart: :rocket:\n```\n\n:fire:";
    // 代码块范围覆盖整个 ``` 块
    const codeStart = doc.indexOf("```");
    const codeEnd = doc.lastIndexOf("```") + 3;
    const r = findEmojiShortcodesInRange(doc, 0, doc.length, [
      { from: codeStart, to: codeEnd },
    ]);
    expect(r.map((x) => x.shortcode).sort()).toEqual(["fire", "smile"]);
  });

  it("shortcode 跨段边界（from..to 不完整覆盖）不返回", () => {
    // :smile: 范围 [0, 7)，段范围 [3, 10) 只覆盖部分 → 不应返回（避免半截替换）
    const doc = ":smile:";
    const r = findEmojiShortcodesInRange(doc, 3, 10, []);
    expect(r).toHaveLength(0);
  });

  it("空段返回空数组", () => {
    expect(findEmojiShortcodesInRange("", 0, 0, [])).toEqual([]);
  });

  it("冒号不成对（无 shortcode）返回空数组", () => {
    const doc = "time is 10:30 and 12:45";
    const r = findEmojiShortcodesInRange(doc, 0, doc.length, []);
    expect(r).toEqual([]);
  });

  it("返回结果按 from 升序", () => {
    const doc = ":rocket: :smile: :heart:";
    const r = findEmojiShortcodesInRange(doc, 0, doc.length, []);
    expect(r.map((x) => x.from)).toEqual([...r.map((x) => x.from)].sort((a, b) => a - b));
  });
});
