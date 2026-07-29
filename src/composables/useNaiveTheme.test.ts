import { describe, it, expect } from "vitest";
import {
  createMurasakiThemeOverrides,
  resolveEffectiveMode,
  type UiMode,
} from "./useNaiveTheme";

describe("composables/useNaiveTheme", () => {
  describe("resolveEffectiveMode", () => {
    it("system + 系统深色 → dark", () => {
      expect(resolveEffectiveMode("system", true)).toBe("dark");
    });
    it("system + 系统浅色 → light", () => {
      expect(resolveEffectiveMode("system", false)).toBe("light");
    });
    it("显式 light 覆盖系统深色", () => {
      expect(resolveEffectiveMode("light", true)).toBe("light");
    });
    it("显式 dark 覆盖系统浅色", () => {
      expect(resolveEffectiveMode("dark", false)).toBe("dark");
    });
    it("纯函数：相同输入恒等输出", () => {
      const a = resolveEffectiveMode("system" as UiMode, true);
      const b = resolveEffectiveMode("system" as UiMode, true);
      expect(a).toBe(b);
    });
  });

  describe("createMurasakiThemeOverrides", () => {
    it("返回包含 common 的配置对象", () => {
      const overrides = createMurasakiThemeOverrides("light");
      expect(overrides).toHaveProperty("common");
      expect(typeof overrides.common).toBe("object");
      expect(overrides.common).not.toBeNull();
    });

    it("纯函数：相同 mode 返回等价配置", () => {
      const a = createMurasakiThemeOverrides("dark");
      const b = createMurasakiThemeOverrides("dark");
      expect(a).toEqual(b);
    });

    it("浅色与深色返回不同的 bodyColor/cardColor/popoverColor", () => {
      const light = createMurasakiThemeOverrides("light");
      const dark = createMurasakiThemeOverrides("dark");
      expect(light.common!.bodyColor).not.toBe(dark.common!.bodyColor);
      expect(light.common!.cardColor).not.toBe(dark.common!.cardColor);
      expect(light.common!.popoverColor).not.toBe(dark.common!.popoverColor);
    });

    it("品牌主色（紫色）在浅色/深色模式下一致，对齐 --murasaki-primary", () => {
      const light = createMurasakiThemeOverrides("light");
      const dark = createMurasakiThemeOverrides("dark");
      // --murasaki-primary: #9333ea (purple-600)
      expect(light.common!.primaryColor).toBe("#9333ea");
      expect(dark.common!.primaryColor).toBe("#9333ea");
      // hover/pressed/suppl 对齐 --murasaki-purple-* 色板
      expect(light.common!.primaryColorHover).toBe("#c084fc");
      expect(light.common!.primaryColorPressed).toBe("#7e22ce");
      expect(light.common!.primaryColorSuppl).toBe("#a855f7");
    });

    it("状态色对齐 --murasaki-state-* 且浅色/深色一致", () => {
      const light = createMurasakiThemeOverrides("light");
      const dark = createMurasakiThemeOverrides("dark");
      expect(light.common!.successColor).toBe("#16a34a");
      expect(light.common!.warningColor).toBe("#d97706");
      expect(light.common!.errorColor).toBe("#dc2626");
      expect(light.common!.infoColor).toBe("#2563eb");
      expect(dark.common!.successColor).toBe(light.common!.successColor);
    });

    it("圆角对齐 --murasaki-radius-sm/md", () => {
      const overrides = createMurasakiThemeOverrides("light");
      expect(overrides.common!.borderRadius).toBe("8px");
      expect(overrides.common!.borderRadiusSmall).toBe("4px");
    });

    it("字体对齐 --murasaki-font-ui / --murasaki-font-mono", () => {
      const overrides = createMurasakiThemeOverrides("light");
      expect(overrides.common!.fontFamily).toContain("Inter");
      expect(overrides.common!.fontFamily).toContain("Noto Sans SC");
      expect(overrides.common!.fontFamilyMono).toContain("JetBrains Mono");
    });

    it("浅色模式文字/边框对齐 --murasaki token", () => {
      const c = createMurasakiThemeOverrides("light").common!;
      // --murasaki-foreground: #171717
      expect(c.textColor1).toBe("#171717");
      expect(c.textColorBase).toBe("#171717");
      // --murasaki-ink-2: #525252
      expect(c.textColor2).toBe("#525252");
      // --murasaki-muted-foreground: #737373
      expect(c.textColor3).toBe("#737373");
      // --murasaki-border: #e5e5e5
      expect(c.borderColor).toBe("#e5e5e5");
      expect(c.dividerColor).toBe("#e5e5e5");
      // --murasaki-background: #ffffff
      expect(c.bodyColor).toBe("#ffffff");
      // --murasaki-popover: #ffffff
      expect(c.popoverColor).toBe("#ffffff");
      // --murasaki-muted: #f5f5f5
      expect(c.hoverColor).toBe("#f5f5f5");
    });

    it("深色模式文字/边框对齐 --murasaki token（深色覆盖）", () => {
      const c = createMurasakiThemeOverrides("dark").common!;
      // --murasaki-foreground (dark): #e5e7eb
      expect(c.textColor1).toBe("#e5e7eb");
      expect(c.textColorBase).toBe("#e5e7eb");
      // --murasaki-border (dark): #2a2a35
      expect(c.borderColor).toBe("#2a2a35");
      // --murasaki-background (dark): #0f0f14
      expect(c.bodyColor).toBe("#0f0f14");
      // --murasaki-popover (dark): #1c1c24
      expect(c.popoverColor).toBe("#1c1c24");
      // --murasaki-muted (dark): #1f1f28
      expect(c.hoverColor).toBe("#1f1f28");
    });

    it("深色模式无白底：body/card/popover/modal 均为深色", () => {
      const c = createMurasakiThemeOverrides("dark").common!;
      const isDark = (hex: string | undefined): boolean => {
        if (!hex) return false;
        const m = /^#([0-9a-f]{6})$/i.exec(hex);
        if (!m) return false;
        const r = parseInt(m[1].slice(0, 2), 16);
        const g = parseInt(m[1].slice(2, 4), 16);
        const b = parseInt(m[1].slice(4, 6), 16);
        // 相对亮度 < 0.2 视为深色
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.2;
      };
      expect(isDark(c.bodyColor)).toBe(true);
      expect(isDark(c.cardColor)).toBe(true);
      expect(isDark(c.popoverColor)).toBe(true);
      expect(isDark(c.modalColor)).toBe(true);
    });

    it("阴影对齐 --murasaki-shadow-* 且浅色/深色一致", () => {
      const light = createMurasakiThemeOverrides("light");
      const dark = createMurasakiThemeOverrides("dark");
      expect(light.common!.boxShadow1).toBe("0 1px 2px rgba(15, 23, 42, 0.04)");
      expect(light.common!.boxShadow2).toBe("0 4px 12px rgba(15, 23, 42, 0.08)");
      expect(light.common!.boxShadow3).toBe("0 12px 32px rgba(15, 23, 42, 0.12)");
      expect(dark.common!.boxShadow1).toBe(light.common!.boxShadow1);
    });

    it("NPopover 组件级 overrides 对齐 --murasaki-* token（T5.1, issue #71）", () => {
      const light = createMurasakiThemeOverrides("light");
      const dark = createMurasakiThemeOverrides("dark");
      expect(light).toHaveProperty("Popover");
      // color 对齐 --murasaki-popover
      expect(light.Popover!.color).toBe("#ffffff");
      expect(dark.Popover!.color).toBe("#1c1c24");
      // textColor 对齐 --murasaki-popover-foreground
      expect(light.Popover!.textColor).toBe("#171717");
      expect(dark.Popover!.textColor).toBe("#e5e7eb");
      // borderRadius 对齐 --murasaki-radius-md
      expect(light.Popover!.borderRadius).toBe("8px");
      // boxShadow 对齐 --murasaki-shadow-lg
      expect(light.Popover!.boxShadow).toBe("0 12px 32px rgba(15, 23, 42, 0.12)");
      expect(dark.Popover!.boxShadow).toBe(light.Popover!.boxShadow);
    });
  });
});
