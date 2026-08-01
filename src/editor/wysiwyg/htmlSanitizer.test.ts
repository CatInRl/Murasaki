/**
 * T6.4 (issue #103) — 内联 HTML 安全渲染纯函数测试。
 *
 * 规则（spec）：
 * - 通过 DOMPurify 净化 + 白名单标签渲染内联 HTML，防 XSS
 * - XSS payload（script / iframe / object / embed / on* 事件属性 / javascript: URL）被清除
 * - 白名单标签（span / div / p / strong / em / code 等）及 style / class 属性保留
 *
 * 集成位置：
 * - useMarkdownRenderer.render() —— 预览 / 导出 / WYSIWYG 表格 widget 共享
 * - wysiwygPlugin HtmlWidget —— WYSIWYG 模式 HTML 块 widget 渲染前净化
 */
import { describe, it, expect } from "vitest";
import { sanitizeInlineHtml } from "./htmlSanitizer";

describe("sanitizeInlineHtml — XSS 净化", () => {
  it("<script> 标签被清除", () => {
    const html = `<p>safe</p><script>alert('xss')</script>`;
    const out = sanitizeInlineHtml(html);
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("alert");
    expect(out).toContain("<p>safe</p>");
  });

  it("<iframe> 标签被清除", () => {
    const html = `<iframe src="https://evil.com"></iframe><p>ok</p>`;
    const out = sanitizeInlineHtml(html);
    expect(out).not.toContain("<iframe");
    expect(out).toContain("<p>ok</p>");
  });

  it("<object> / <embed> 标签被清除", () => {
    const html = `<object data="evil.swf"></object><embed src="evil.swf">`;
    const out = sanitizeInlineHtml(html);
    expect(out).not.toContain("<object");
    expect(out).not.toContain("<embed");
  });

  it("<form> 标签被清除（防止表单钓鱼）", () => {
    const html = `<form action="https://evil.com"><button>submit</button></form>`;
    const out = sanitizeInlineHtml(html);
    expect(out).not.toContain("<form");
    expect(out).not.toContain("<button");
  });

  it("on* 事件属性被清除（onclick / onerror / onload 等）", () => {
    const html = `<div onclick="alert(1)" onerror="alert(2)" onload="alert(3)">text</div>`;
    const out = sanitizeInlineHtml(html);
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("onload");
    expect(out).toContain(">text</div>");
  });

  it("javascript: URL 被清除（href / src）", () => {
    const html = `<a href="javascript:alert(1)">click</a><img src="javascript:alert(2)">`;
    const out = sanitizeInlineHtml(html);
    // DOMPurify 会移除 javascript: 协议的 href/src（保留标签但移除属性或整个标签）
    expect(out.toLowerCase()).not.toContain("javascript:");
  });

  it("data: URL 在 img src 上保留（Base64 图片合法），在其他上下文按 DOMPurify 默认处理", () => {
    const html = `<img src="data:image/png;base64,iVBORw0KGgo=" alt="pic">`;
    const out = sanitizeInlineHtml(html);
    expect(out).toContain("data:image/png;base64,");
  });

  it("SVG 中的 <script> 被清除（防止 SVG XSS）", () => {
    const html = `<svg><script>alert(1)</script></svg>`;
    const out = sanitizeInlineHtml(html);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
  });

  it("HTML 注释中的条件注释被清除（防止 IE 条件注释 SSRF）", () => {
    const html = `<!--[if IE]><script>alert(1)</script><![endif]-->`;
    const out = sanitizeInlineHtml(html);
    expect(out).not.toContain("alert(1)");
  });

  it("嵌套的恶意标签被清除", () => {
    const html = `<div><script>alert(1)</script><p>safe</p><iframe src="evil"></iframe></div>`;
    const out = sanitizeInlineHtml(html);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<iframe");
    expect(out).toContain("<p>safe</p>");
  });

  it("task list 复选框 <input type=\"checkbox\"> 保留（task list 依赖）", () => {
    const html = `<ul><li><input type="checkbox" checked>task</li></ul>`;
    const out = sanitizeInlineHtml(html);
    expect(out).toContain("<input");
    expect(out).toContain('type="checkbox"');
    expect(out).toContain("checked");
    expect(out).toContain("task");
  });
});

describe("sanitizeInlineHtml — 白名单标签保留", () => {
  it("<span style=\"color:red\"> 保留 style 属性", () => {
    const html = `<span style="color:red">red text</span>`;
    const out = sanitizeInlineHtml(html);
    expect(out).toContain("<span");
    expect(out).toContain('style="color:red"');
    expect(out).toContain("red text");
  });

  it("<div class=\"note\"> 保留 class 属性", () => {
    const html = `<div class="note">content</div>`;
    const out = sanitizeInlineHtml(html);
    expect(out).toContain("<div");
    expect(out).toContain('class="note"');
    expect(out).toContain("content");
  });

  it("常见格式标签（strong / em / code / mark / sub / sup）保留", () => {
    const html = `<strong>bold</strong><em>italic</em><code>monospace</code><mark>highlight</mark><sub>sub</sub><sup>sup</sup>`;
    const out = sanitizeInlineHtml(html);
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>italic</em>");
    expect(out).toContain("<code>monospace</code>");
    expect(out).toContain("<mark>highlight</mark>");
    expect(out).toContain("<sub>sub</sub>");
    expect(out).toContain("<sup>sup</sup>");
  });

  it("块级标签（p / h1 / blockquote / pre / ul / li）保留", () => {
    const html = `<p>paragraph</p><h1>heading</h1><blockquote>quote</blockquote><pre>code</pre><ul><li>item</li></ul>`;
    const out = sanitizeInlineHtml(html);
    expect(out).toContain("<p>paragraph</p>");
    expect(out).toContain("<h1>heading</h1>");
    expect(out).toContain("<blockquote>quote</blockquote>");
    expect(out).toContain("<pre>code</pre>");
    expect(out).toContain("<ul><li>item</li></ul>");
  });

  it("<a href=\"https://...\"> 合法外部链接保留", () => {
    const html = `<a href="https://example.com" title="example">link</a>`;
    const out = sanitizeInlineHtml(html);
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain(">link</a>");
  });

  it("<img src=\"https://...\"> 合法图片保留", () => {
    const html = `<img src="https://example.com/a.png" alt="alt text">`;
    const out = sanitizeInlineHtml(html);
    expect(out).toContain('src="https://example.com/a.png"');
    expect(out).toContain('alt="alt text"');
  });

  it("<table> 结构保留（含 thead / tbody / tr / td）", () => {
    const html = `<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>D</td></tr></tbody></table>`;
    const out = sanitizeInlineHtml(html);
    expect(out).toContain("<table>");
    expect(out).toContain("<thead>");
    expect(out).toContain("<tbody>");
    expect(out).toContain("<th>H</th>");
    expect(out).toContain("<td>D</td>");
  });

  it("嵌套的白名单标签结构保留", () => {
    const html = `<div class="card"><p>paragraph with <strong>bold</strong> and <em>italic</em></p></div>`;
    const out = sanitizeInlineHtml(html);
    expect(out).toContain('<div class="card">');
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>italic</em>");
  });
});

describe("sanitizeInlineHtml — 边界情况", () => {
  it("空字符串返回空字符串", () => {
    expect(sanitizeInlineHtml("")).toBe("");
  });

  it("纯文本（无 HTML 标签）原样返回", () => {
    const html = `just plain text without tags`;
    expect(sanitizeInlineHtml(html)).toBe(html);
  });

  it("无效 HTML 容错（不抛异常）", () => {
    const html = `<div>unclosed tag <p>another`;
    expect(() => sanitizeInlineHtml(html)).not.toThrow();
    const out = sanitizeInlineHtml(html);
    expect(out).toContain("unclosed tag");
    expect(out).toContain("another");
  });

  it("多次调用结果一致（无状态）", () => {
    const html = `<script>alert(1)</script><p>safe</p>`;
    const out1 = sanitizeInlineHtml(html);
    const out2 = sanitizeInlineHtml(html);
    expect(out1).toBe(out2);
  });

  it("复杂内联样式（含多个 CSS 属性）保留", () => {
    const html = `<span style="color:red;font-weight:bold;font-size:14px">styled</span>`;
    const out = sanitizeInlineHtml(html);
    expect(out).toContain("color:red");
    expect(out).toContain("font-weight:bold");
    expect(out).toContain("font-size:14px");
  });

  it("表达式注入（${...}）不引发异常，按文本处理", () => {
    const html = `<span style="color:${"red"}">text</span>`;
    expect(() => sanitizeInlineHtml(html)).not.toThrow();
  });
});
