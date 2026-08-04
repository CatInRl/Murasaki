import { describe, it, expect } from "vitest";
import { createMurasakiThemeOverrides } from "./useNaiveTheme";

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
      // --murasaki-primary: #9333ea (purple-600)
      expect(c.primaryColor).toBe("#9333ea");
      // hover/pressed/suppl 对齐 --murasaki-purple-* 色板
      expect(c.primaryColorHover).toBe("#c084fc");
      expect(c.primaryColorPressed).toBe("#7e22ce");
      expect(c.primaryColorSuppl).toBe("#a855f7");
    });

    it("状态色对齐 --murasaki-state-*", () => {
      const c = createMurasakiThemeOverrides().common!;
      expect(c.successColor).toBe("#16a34a");
      expect(c.warningColor).toBe("#d97706");
      expect(c.errorColor).toBe("#dc2626");
      expect(c.infoColor).toBe("#2563eb");
    });

    it("圆角对齐 --murasaki-radius-sm/md", () => {
      const c = createMurasakiThemeOverrides().common!;
      expect(c.borderRadius).toBe("8px");
      expect(c.borderRadiusSmall).toBe("4px");
    });

    it("字体对齐 --murasaki-font-ui / --murasaki-font-mono", () => {
      const c = createMurasakiThemeOverrides().common!;
      expect(c.fontFamily).toContain("Inter");
      expect(c.fontFamily).toContain("Noto Sans SC");
      expect(c.fontFamilyMono).toContain("JetBrains Mono");
    });

    it("文字/边框对齐 --murasaki token", () => {
      const c = createMurasakiThemeOverrides().common!;
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

    it("阴影对齐 --murasaki-shadow-*", () => {
      const c = createMurasakiThemeOverrides().common!;
      expect(c.boxShadow1).toBe("0 1px 2px rgba(15, 23, 42, 0.04)");
      expect(c.boxShadow2).toBe("0 4px 12px rgba(15, 23, 42, 0.08)");
      expect(c.boxShadow3).toBe("0 12px 32px rgba(15, 23, 42, 0.12)");
    });

    it("NPopover 组件级 overrides 对齐 --murasaki-* token（T5.1, issue #71）", () => {
      const overrides = createMurasakiThemeOverrides();
      expect(overrides).toHaveProperty("Popover");
      // color 对齐 --murasaki-popover
      expect(overrides.Popover!.color).toBe("#ffffff");
      // textColor 对齐 --murasaki-popover-foreground
      expect(overrides.Popover!.textColor).toBe("#171717");
      // borderRadius 对齐 --murasaki-radius-md
      expect(overrides.Popover!.borderRadius).toBe("8px");
      // boxShadow 对齐 --murasaki-shadow-lg
      expect(overrides.Popover!.boxShadow).toBe("0 12px 32px rgba(15, 23, 42, 0.12)");
    });
  });
});
