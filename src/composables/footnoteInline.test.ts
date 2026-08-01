/**
 * T6.3 (issue #101) — 脚注原位渲染测试。
 *
 * 规则（spec）：
 * - `[^1]` 脚注定义在原位渲染为脚注块（而非文末汇聚的 footnotes-list）
 * - 点击脚注引用跳转到定义（href anchor 指向定义 id）
 * - 多个脚注各自在原位渲染
 * - 同一脚注多次引用共享同一个定义 id
 */
import { describe, it, expect } from "vitest";
import { getMarkdownRenderer } from "./useMarkdownRenderer";

describe("脚注原位渲染 (T6.3 / #101)", () => {
  it("[^1]: 定义在原位渲染为脚注块（不在文末汇聚）", () => {
    const md = getMarkdownRenderer();
    const source = "Some text[^1]\n\n[^1]: This is a footnote\n\nMore text";
    const html = md.render(source);

    // 脚注定义应在原位（在 "More text" 之前）
    const defPos = html.indexOf("footnote-def");
    const morePos = html.indexOf("More text");
    expect(defPos).toBeGreaterThan(-1);
    expect(defPos).toBeLessThan(morePos);

    // 不应在文末有 footnotes-list（旧的文末汇聚行为已禁用）
    expect(html).not.toContain("footnotes-list");
    expect(html).not.toContain("footnotes-sep");
  });

  it("[^1] 引用链接指向原位定义的 id", () => {
    const md = getMarkdownRenderer();
    const source = "Text[^1]\n\n[^1]: footnote text";
    const html = md.render(source);

    // 引用应有 href 指向定义 id
    expect(html).toMatch(/href="#fn-1"/);
    // 定义应有对应 id
    expect(html).toMatch(/id="fn-1"/);
  });

  it("多个脚注各自原位渲染（不汇聚到文末）", () => {
    const md = getMarkdownRenderer();
    const source = [
      "First[^1]",
      "",
      "[^1]: First footnote",
      "",
      "Second[^2]",
      "",
      "[^2]: Second footnote",
    ].join("\n");
    const html = md.render(source);

    // 两个定义都存在
    const def1Pos = html.indexOf('id="fn-1"');
    const def2Pos = html.indexOf('id="fn-2"');
    expect(def1Pos).toBeGreaterThan(-1);
    expect(def2Pos).toBeGreaterThan(-1);

    // 第一定义在第二定义之前（各自原位）
    expect(def1Pos).toBeLessThan(def2Pos);

    // 不应有文末汇聚的 footnotes-list
    expect(html).not.toContain("footnotes-list");
  });

  it("脚注引用使用 [n] 编号显示", () => {
    const md = getMarkdownRenderer();
    const source = "Text[^1]\n\n[^1]: footnote";
    const html = md.render(source);
    expect(html).toContain("[1]");
  });

  it("同一脚注多次引用都指向同一定义 id", () => {
    const md = getMarkdownRenderer();
    const source = "First[^1] and again[^1]\n\n[^1]: footnote";
    const html = md.render(source);
    // 两个引用都指向同一个定义
    const matches = html.match(/href="#fn-1"/g);
    expect(matches).toHaveLength(2);
  });

  it("脚注定义内容正常渲染（含 markdown 语法）", () => {
    const md = getMarkdownRenderer();
    const source = "Text[^1]\n\n[^1]: This is **bold** footnote";
    const html = md.render(source);
    // 脚注定义内的 markdown 语法正常渲染
    expect(html).toContain("<strong>bold</strong>");
  });

  it("无脚注的文档不受影响", () => {
    const md = getMarkdownRenderer();
    const html = md.render("Just a normal paragraph");
    expect(html).not.toContain("footnote");
  });

  it("脚注引用渲染为 <sup> 标签", () => {
    const md = getMarkdownRenderer();
    const source = "Text[^1]\n\n[^1]: footnote";
    const html = md.render(source);
    expect(html).toContain('<sup class="footnote-ref">');
  });

  it("脚注定义渲染为带 class 的容器", () => {
    const md = getMarkdownRenderer();
    const source = "Text[^1]\n\n[^1]: footnote";
    const html = md.render(source);
    expect(html).toContain('class="footnote-def"');
  });
});
