import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Mermaid 节点文字裁切守卫（issue #342）
 *
 * 背景：mermaid 按自带行高（16px × 1.5 = 24px）测量节点文本并分配 foreignObject
 * 高度，而 `.markdown-body p` 的 1.75 行高会级联进 foreignObject 内的 <p>，实际
 * 排版比测量基准每行多出 4px——溢出随行数线性增长，节点文字超过约 4 行即被方框
 * 视觉裁切（分栏预览 / WYSIWYG / 演示模式三个入口同病：WYSIWYG 容器也带
 * .markdown-body class）。
 *
 * 修复是 markdown-content.css 里的一条覆盖规则：
 *   `.markdown-body .mermaid svg p { line-height: inherit; }`
 * 纯静态 CSS 没有逻辑分支可测（jsdom 不做布局），且这类「关键覆盖规则被顺手删掉 /
 * 选择器被重命名」历史上没有任何拦截，故像 tokenGuard / i18nKeyGuard 一样做静态
 * 守卫。行为层面的红绿闭环证据见 issue #342 讨论（Edge headless 夹具：
 * 修复前 6 例全 RED、溢出 = 4px × 行数；修复后 6 例全 GREEN、溢出 = 0）。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(HERE, "markdown-content.css");
const TARGET_SELECTOR = ".markdown-body .mermaid svg p";

/**
 * 抽出 CSS 中的顶层规则块，返回匹配目标选择器且声明体含
 * `line-height: inherit` 的规则声明体；找不到返回 null。
 * 不解析 @media 等嵌套块（目标规则在顶层，嵌套内的规则不会被误报为存在）。
 */
export function findMermaidSvgPLineHeightRule(css: string): string | null {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of noComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]
      .split(",")
      .map((s) => s.replace(/\s+/g, " ").trim());
    if (
      selectors.includes(TARGET_SELECTOR) &&
      /line-height\s*:\s*inherit/.test(m[2])
    ) {
      return m[2].trim();
    }
  }
  return null;
}

describe("mermaid 节点文字裁切守卫（issue #342）", () => {
  const css = readFileSync(CSS_PATH, "utf8");

  it("markdown-content.css 非空（防止文件被清空后守卫静默通过）", () => {
    expect(css.length).toBeGreaterThan(1000);
  });

  it(`存在 ${TARGET_SELECTOR} { line-height: inherit } 覆盖规则`, () => {
    expect(
      findMermaidSvgPLineHeightRule(css),
      `缺失 ${TARGET_SELECTOR} { line-height: inherit } —— mermaid 节点文字超过约 4 行会被方框裁切（issue #342）。` +
        "若确需移除，请先确认 mermaid 已改为按真实行高测量节点文本。"
    ).not.toBeNull();
  });

  it("守卫本身能识别缺失/形制错误的规则（样例验证）", () => {
    expect(findMermaidSvgPLineHeightRule(".markdown-body .mermaid svg p { color: red; }")).toBeNull();
    expect(
      findMermaidSvgPLineHeightRule(`${TARGET_SELECTOR} { line-height: inherit; }`)
    ).not.toBeNull();
    expect(
      findMermaidSvgPLineHeightRule(
        ".markdown-body .mermaid svg span,\n  .markdown-body .mermaid svg p { line-height: inherit; }"
      )
    ).not.toBeNull();
    expect(
      findMermaidSvgPLineHeightRule(
        `/* 注释里出现 ${TARGET_SELECTOR} { line-height: inherit } */`
      )
    ).toBeNull();
    expect(
      findMermaidSvgPLineHeightRule(
        ".markdown-body .mermaid svg p { line-height: 1.75; }"
      )
    ).toBeNull();
  });
});
