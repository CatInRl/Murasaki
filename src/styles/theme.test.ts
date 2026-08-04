import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Ticket #60 — T0.3 补全 theme.css token
 *
 * 这些测试断言 theme.css 中存在 ticket 要求的 CSS 变量定义，覆盖验收标准：
 *   - theme.css 包含上述 token 定义
 *
 * 实现细节不测（不解析 CSS AST、不断言具体颜色值），只断言变量名存在，
 * 这样后续调整数值时测试不会频繁失败（符合 spec.md 的测试哲学）。
 */
const themeCss = readFileSync(
  resolve(process.cwd(), "src/styles/theme.css"),
  "utf-8",
);

describe("styles/theme.css tokens — Ticket #60", () => {
  describe("字号 token（:root 全局）", () => {
    it.each<[string, string]>([
      ["--murasaki-text-xs", "12px"],
      ["--murasaki-text-sm", "13px"],
      ["--murasaki-text-base", "14px"],
      ["--murasaki-text-lg", "16px"],
      ["--murasaki-text-xl", "20px"],
      ["--murasaki-text-2xl", "24px"],
    ])("定义 %s = %s", (token, value) => {
      expect(themeCss).toContain(`${token}: ${value}`);
    });
  });

  describe("阴影 token", () => {
    it.each([
      "--murasaki-shadow-sm",
      "--murasaki-shadow-md",
      "--murasaki-shadow-lg",
      "--murasaki-shadow-2",
    ])("定义 %s", (token) => {
      expect(themeCss).toContain(`${token}:`);
    });

    it("--murasaki-shadow-2 在浅色模式（:root）中定义", () => {
      const rootBlock = themeCss.match(/:root\s*\{[\s\S]*?\}/);
      expect(rootBlock).not.toBeNull();
      expect(rootBlock![0]).toContain("--murasaki-shadow-2:");
    });

    it("不含 prefers-color-scheme: dark 媒体查询（issue #114 移除深色模式）", () => {
      expect(themeCss).not.toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
    });

    it("不含 [data-theme=\"dark\"] 选择器（issue #114 移除深色模式）", () => {
      expect(themeCss).not.toMatch(/\[data-theme="dark"\]/);
    });
  });

  describe("布局 token", () => {
    it("定义 --murasaki-menubar-height = 32px（仅设计参考用）", () => {
      expect(themeCss).toContain("--murasaki-menubar-height: 32px");
    });
  });

  describe("过渡 token", () => {
    it("定义 --murasaki-transition-fast = 120ms ease", () => {
      expect(themeCss).toContain("--murasaki-transition-fast: 120ms ease");
    });
  });

  describe("不应 token 化的项保留硬编码（反向断言）", () => {
    // 间距 / 字重 / 行高 不应被引入为 murasaki token
    it("未引入间距 token（如 --murasaki-space-*）", () => {
      expect(themeCss).not.toMatch(/--murasaki-space-/);
    });
    it("未引入字重 token（如 --murasaki-weight-*）", () => {
      expect(themeCss).not.toMatch(/--murasaki-weight-/);
    });
    it("未引入行高 token（如 --murasaki-leading-*）", () => {
      expect(themeCss).not.toMatch(/--murasaki-leading-/);
    });
  });
});
