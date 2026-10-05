import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createMurasakiThemeOverrides } from "./useNaiveTheme";

/**
 * 把 theme.css 注入 jsdom 的 `<style>`，用 `getComputedStyle` 读到声明原文，再自行展开
 * `var()` 链，得到 token 的**解析值**。
 *
 * 为什么要展开 var()：jsdom 不解析自定义属性里的 `var()`（`--a: var(--b)` 会原样返回
 * 字面量 `"var(--b)"`）。展开后断言写的是「TS 常量 == theme.css 对应 token 的解析值」
 * 这种**引用关系**，而不是复述字面 hex：改主色（`--murasaki-purple-600`）时测试自动
 * 跟随，不会因数值同步滞后而误报（issue #296）。
 */
const themeCss = readFileSync(resolve(process.cwd(), "src/styles/theme.css"), "utf-8");

let rootStyles: CSSStyleDeclaration | null = null;
function getRootStyles(): CSSStyleDeclaration {
  if (!rootStyles) {
    const style = document.createElement("style");
    style.textContent = themeCss;
    document.head.appendChild(style);
    rootStyles = getComputedStyle(document.documentElement);
  }
  return rootStyles;
}

/** 展开 token 值里的 var(...) 引用，返回最终解析值 */
export function resolvedToken(name: string, seen: Set<string> = new Set()): string {
  if (seen.has(name)) return "";
  seen.add(name);
  const raw = getRootStyles().getPropertyValue(name).trim();
  if (!raw) return "";
  let value = raw;
  let guard = 0;
  while (/var\(/.test(value) && guard++ < 20) {
    value = value.replace(
      /var\(\s*(--[A-Za-z0-9-]+)\s*\)/g,
      (_m, ref: string) => resolvedToken(ref, seen)
    );
  }
  return value;
}

/**
 * 归一化：去首尾空白、转小写，并压缩逗号两侧空白。jsdom 各版本对 CSS 值的空白序列化
 * 不一致（30 起保留声明原文，旧版按 `, ` 规范化），比较前先抹平这层差异。
 */
const norm = (value: string): string =>
  value.trim().toLowerCase().replace(/\s*,\s*/g, ",");

describe("composables/useNaiveTheme", () => {
  describe("createMurasakiThemeOverrides", () => {
    it("返回包含 common 的配置对象", () => {
      const overrides = createMurasakiThemeOverrides();
      expect(overrides).toHaveProperty("common");
      expect(typeof overrides.common).toBe("object");
      expect(overrides.common).not.toBeNull();
    });

    it("纯函数：多次调用返回等价配置", () => {
      const a = createMurasakiThemeOverrides();
      const b = createMurasakiThemeOverrides();
      expect(a).toEqual(b);
    });

    it("品牌主色（紫色）对齐 --murasaki-primary", () => {
      const c = createMurasakiThemeOverrides().common!;
      expect(c.primaryColor).toBe(resolvedToken("--murasaki-primary"));
      expect(c.primaryColorHover).toBe(resolvedToken("--murasaki-purple-400"));
      expect(c.primaryColorPressed).toBe(resolvedToken("--murasaki-purple-700"));
      expect(c.primaryColorSuppl).toBe(resolvedToken("--murasaki-purple-500"));
    });

    it("状态色对齐 --murasaki-state-*", () => {
      const c = createMurasakiThemeOverrides().common!;
      expect(c.successColor).toBe(resolvedToken("--murasaki-state-success"));
      expect(c.warningColor).toBe(resolvedToken("--murasaki-state-warning"));
      expect(c.errorColor).toBe(resolvedToken("--murasaki-state-error"));
      expect(c.infoColor).toBe(resolvedToken("--murasaki-state-info"));
    });

    it("圆角对齐 --murasaki-radius-sm/md", () => {
      const c = createMurasakiThemeOverrides().common!;
      expect(c.borderRadius).toBe(resolvedToken("--murasaki-radius-md"));
      expect(c.borderRadiusSmall).toBe(resolvedToken("--murasaki-radius-sm"));
    });

    it("字体对齐 --murasaki-font-ui / --murasaki-font-mono", () => {
      const c = createMurasakiThemeOverrides().common!;
      expect(norm(String(c.fontFamily))).toBe(norm(resolvedToken("--murasaki-font-ui")));
      expect(norm(String(c.fontFamilyMono))).toBe(norm(resolvedToken("--murasaki-font-mono")));
      expect(c.fontFamily).toContain("Inter");
    });

    it("文字/边框对齐 --murasaki token", () => {
      const c = createMurasakiThemeOverrides().common!;
      expect(c.textColorBase).toBe(resolvedToken("--murasaki-foreground"));
      expect(c.textColor1).toBe(resolvedToken("--murasaki-foreground"));
      expect(c.textColor2).toBe(resolvedToken("--murasaki-ink-2"));
      expect(c.textColor3).toBe(resolvedToken("--murasaki-muted-foreground"));
      expect(c.placeholderColor).toBe(resolvedToken("--murasaki-ink-3"));
      expect(c.borderColor).toBe(resolvedToken("--murasaki-border"));
      expect(c.dividerColor).toBe(resolvedToken("--murasaki-border"));
      expect(c.bodyColor).toBe(resolvedToken("--murasaki-background"));
      expect(c.popoverColor).toBe(resolvedToken("--murasaki-popover"));
      expect(c.hoverColor).toBe(resolvedToken("--murasaki-muted"));
    });

    it("阴影对齐 --murasaki-shadow-*", () => {
      const c = createMurasakiThemeOverrides().common!;
      expect(norm(String(c.boxShadow1))).toBe(norm(resolvedToken("--murasaki-shadow-sm")));
      expect(norm(String(c.boxShadow2))).toBe(norm(resolvedToken("--murasaki-shadow-md")));
      expect(norm(String(c.boxShadow3))).toBe(norm(resolvedToken("--murasaki-shadow-lg")));
    });

    it("NPopover 组件级 overrides 对齐 --murasaki-* token（T5.1, issue #71）", () => {
      const overrides = createMurasakiThemeOverrides();
      expect(overrides).toHaveProperty("Popover");
      expect(overrides.Popover!.color).toBe(resolvedToken("--murasaki-popover"));
      expect(overrides.Popover!.textColor).toBe(resolvedToken("--murasaki-popover-foreground"));
      expect(overrides.Popover!.borderRadius).toBe(resolvedToken("--murasaki-radius-md"));
      expect(norm(String(overrides.Popover!.boxShadow))).toBe(
        norm(resolvedToken("--murasaki-shadow-lg"))
      );
    });
  });

  /**
   * 逐项一致性（issue #295 / T3.5、#296 / T4.2）：TS 常量解析值 == theme.css 对应
   * token 解析值。断言的是**引用关系**，改主题色时无需改动本测试。
   */
  describe("与 theme.css 的一致性（逐项引用关系）", () => {
    const cases: Array<[string, string, string]> = [
      // [override 字段, 作用域, theme.css token]
      ["primaryColor", "common", "--murasaki-primary"],
      ["primaryColorHover", "common", "--murasaki-purple-400"],
      ["primaryColorPressed", "common", "--murasaki-purple-700"],
      ["primaryColorSuppl", "common", "--murasaki-purple-500"],
      ["infoColor", "common", "--murasaki-state-info"],
      ["successColor", "common", "--murasaki-state-success"],
      ["warningColor", "common", "--murasaki-state-warning"],
      ["errorColor", "common", "--murasaki-state-error"],
      ["textColorBase", "common", "--murasaki-foreground"],
      ["textColor1", "common", "--murasaki-foreground"],
      ["textColor2", "common", "--murasaki-ink-2"],
      ["textColor3", "common", "--murasaki-muted-foreground"],
      ["placeholderColor", "common", "--murasaki-ink-3"],
      ["bodyColor", "common", "--murasaki-background"],
      ["cardColor", "common", "--murasaki-card"],
      ["popoverColor", "common", "--murasaki-popover"],
      ["tableColor", "common", "--murasaki-surface"],
      ["tableHeaderColor", "common", "--murasaki-muted"],
      ["hoverColor", "common", "--murasaki-muted"],
      ["actionColor", "common", "--murasaki-muted"],
      ["borderColor", "common", "--murasaki-border"],
      ["dividerColor", "common", "--murasaki-border"],
      ["borderRadius", "common", "--murasaki-radius-md"],
      ["borderRadiusSmall", "common", "--murasaki-radius-sm"],
      ["fontFamily", "common", "--murasaki-font-ui"],
      ["fontFamilyMono", "common", "--murasaki-font-mono"],
      ["fontSize", "common", "--murasaki-text-base"],
      ["boxShadow1", "common", "--murasaki-shadow-sm"],
      ["boxShadow2", "common", "--murasaki-shadow-md"],
      ["boxShadow3", "common", "--murasaki-shadow-lg"],
      ["color", "Popover", "--murasaki-popover"],
      ["textColor", "Popover", "--murasaki-popover-foreground"],
      ["borderRadius", "Popover", "--murasaki-radius-md"],
      ["boxShadow", "Popover", "--murasaki-shadow-lg"],
    ];

    it.each(cases)("%s.%s == theme.css 的 %s 解析值", (field, scope, token) => {
      const overrides = createMurasakiThemeOverrides();
      const bucket = (scope === "common" ? overrides.common : overrides.Popover) as
        | Record<string, unknown>
        | undefined;
      expect(bucket).toBeTruthy();
      expect(norm(String(bucket![field]))).toBe(norm(resolvedToken(token)));
    });

    it("primaryColor 即 --murasaki-purple-600 的解析值（引用关系，非字面 hex）", () => {
      const c = createMurasakiThemeOverrides().common!;
      expect(norm(String(c.primaryColor))).toBe(norm(resolvedToken("--murasaki-purple-600")));
    });
  });
});
