/**
 * T6.2 (issue #100) — Frontmatter 范围检测纯函数测试。
 *
 * 规则（spec）：
 * - 文档以 `---\n` 开头，且后续存在独占一行的 `---` 或 `...` 闭合标记 → 是 frontmatter
 * - 返回 {from: 0, to: 闭合标记行末（含换行）, content: 去除首尾包裹的 YAML 文本}
 * - 不满足条件返回 null
 *
 * 这是 WYSIWYG 模式下 frontmatter 卡片 widget 的前置纯函数：
 * 检测到范围后，computeDecorations 在光标离开 frontmatter 时生成 card widget，
 * 点击卡片切源码模式并定位到 frontmatter 起始行。
 */
import { describe, it, expect } from "vitest";
import { findFrontmatterRange } from "./frontmatterDetection";

describe("findFrontmatterRange", () => {
  it("标准 YAML frontmatter（---...---）返回范围与内容", () => {
    const doc = "---\ntitle: Hello\ndate: 2026-01-01\n---\n\nContent";
    const r = findFrontmatterRange(doc);
    expect(r).not.toBeNull();
    expect(r!.from).toBe(0);
    // to 应覆盖到闭合 --- 行末的换行符
    expect(doc.slice(0, r!.to)).toBe("---\ntitle: Hello\ndate: 2026-01-01\n---\n");
    expect(r!.content).toBe("title: Hello\ndate: 2026-01-01");
  });

  it("无 frontmatter（普通文档）返回 null", () => {
    expect(findFrontmatterRange("Hello world")).toBeNull();
  });

  it("文档不以 --- 开头返回 null", () => {
    const doc = "# Title\n\n---\n\ncontent";
    expect(findFrontmatterRange(doc)).toBeNull();
  });

  it("只有起始 --- 无闭合标记返回 null", () => {
    const doc = "---\ntitle: Hello\n";
    expect(findFrontmatterRange(doc)).toBeNull();
  });

  it("frontmatter 后无空行直接接内容也能识别", () => {
    const doc = "---\ntitle: Hello\n---\nContent";
    const r = findFrontmatterRange(doc);
    expect(r).not.toBeNull();
    expect(r!.content).toBe("title: Hello");
    expect(doc.slice(0, r!.to)).toBe("---\ntitle: Hello\n---\n");
  });

  it("空 frontmatter（---\\n---）返回空内容", () => {
    const doc = "---\n---\n\nContent";
    const r = findFrontmatterRange(doc);
    expect(r).not.toBeNull();
    expect(r!.content).toBe("");
    expect(doc.slice(0, r!.to)).toBe("---\n---\n");
  });

  it("闭合标记 ... 也能识别", () => {
    const doc = "---\ntitle: Hello\n...\n\nContent";
    const r = findFrontmatterRange(doc);
    expect(r).not.toBeNull();
    expect(r!.content).toBe("title: Hello");
  });

  it("闭合标记行含尾部空白仍可识别", () => {
    const doc = "---\ntitle: Hello\n---   \n\nContent";
    const r = findFrontmatterRange(doc);
    expect(r).not.toBeNull();
    expect(r!.content).toBe("title: Hello");
  });

  it("闭合标记必须是独占一行（行内 --- 不算）", () => {
    const doc = "---\ntitle: Hello --- not closing\n---\n\nContent";
    const r = findFrontmatterRange(doc);
    expect(r).not.toBeNull();
    expect(r!.content).toBe("title: Hello --- not closing");
  });

  it("frontmatter 是文档起始的唯一标记（第二行 --- 不算起始）", () => {
    // 这个文档第一行是空行，不算 frontmatter
    const doc = "\n---\ntitle: Hello\n---\n";
    expect(findFrontmatterRange(doc)).toBeNull();
  });

  it("单行文档 --- 不是 frontmatter（无闭合标记）", () => {
    expect(findFrontmatterRange("---")).toBeNull();
  });

  it("CRLF 行尾也能识别", () => {
    const doc = "---\r\ntitle: Hello\r\n---\r\n\r\nContent";
    const r = findFrontmatterRange(doc);
    expect(r).not.toBeNull();
    expect(r!.content).toBe("title: Hello");
  });

  it("frontmatter 内含 --- 开头的行（非独占行）不被误判为闭合", () => {
    const doc = "---\nkey: value\n--- not closing\n---\n\nContent";
    const r = findFrontmatterRange(doc);
    expect(r).not.toBeNull();
    expect(r!.content).toBe("key: value\n--- not closing");
  });
});
