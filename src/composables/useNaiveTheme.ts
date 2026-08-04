import { computed, type Ref } from "vue";
import { lightTheme, type GlobalTheme, type GlobalThemeOverrides } from "naive-ui";

/**
 * naive-ui themeOverrides 对齐 --murasaki-* token（ADR-0005）。
 *
 * 0.5.0 移除深色模式（issue #114），仅保留浅色模式。
 * 颜色值与 [src/styles/theme.css] 中的 --murasaki-* token 严格对应。
 */

/** UI 模式字体（来自 --murasaki-font-ui） */
const FONT_UI =
  '"Inter", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
/** UI 模式等宽字体（来自 --murasaki-font-mono） */
const FONT_MONO =
  '"JetBrains Mono", "Fira Code", "Cascadia Code", "Consolas", monospace';

/** 紫色品牌色板（来自 --murasaki-purple-*） */
const PURPLE = {
  400: "#c084fc",
  500: "#a855f7",
  600: "#9333ea",
  700: "#7e22ce",
} as const;

/** 状态色（来自 --murasaki-state-*） */
const STATE = {
  success: "#16a34a",
  warning: "#d97706",
  error: "#dc2626",
  info: "#2563eb",
} as const;

/** 圆角（来自 --murasaki-radius-sm/md） */
const RADIUS_SM = "4px";
const RADIUS_MD = "8px";

/** 阴影（来自 --murasaki-shadow-sm/md/lg） */
const SHADOW = {
  1: "0 1px 2px rgba(15, 23, 42, 0.04)",
  2: "0 4px 12px rgba(15, 23, 42, 0.08)",
  3: "0 12px 32px rgba(15, 23, 42, 0.12)",
} as const;

/** 字号/字重（来自 spec 议题簇 0 token 补全：--murasaki-text-base = 14px） */
const FONT_SIZE_BASE = "14px";
const FONT_WEIGHT = "400";
const FONT_WEIGHT_STRONG = "600";

/** 浅色模式表面/文字/边框调色板，对齐 --murasaki-* 语义 token */
const PALETTE = {
  bodyColor: "#ffffff",
  cardColor: "#fafafa",
  popoverColor: "#ffffff",
  popoverForegroundColor: "#171717",
  modalColor: "#ffffff",
  tableColor: "#f9fafb",
  tableHeaderColor: "#f5f5f5",
  hoverColor: "#f5f5f5",
  actionColor: "#f5f5f5",
  borderColor: "#e5e5e5",
  dividerColor: "#e5e5e5",
  textColorBase: "#171717",
  textColor1: "#171717",
  textColor2: "#525252",
  textColor3: "#737373",
  placeholderColor: "#a3a3a3",
};

/**
 * 生成 naive-ui GlobalThemeOverrides（仅浅色模式）。
 *
 * 纯函数，无副作用，可单元测试断言输出。
 */
export function createMurasakiThemeOverrides(): GlobalThemeOverrides {
  const p = PALETTE;
  return {
    common: {
      // === 品牌主色（紫色）===
      primaryColor: PURPLE[600],
      primaryColorHover: PURPLE[400],
      primaryColorPressed: PURPLE[700],
      primaryColorSuppl: PURPLE[500],

      // === 状态色 ===
      infoColor: STATE.info,
      successColor: STATE.success,
      warningColor: STATE.warning,
      errorColor: STATE.error,

      // === 文字色 ===
      textColorBase: p.textColorBase,
      textColor1: p.textColor1,
      textColor2: p.textColor2,
      textColor3: p.textColor3,
      placeholderColor: p.placeholderColor,

      // === 表面/背景色 ===
      bodyColor: p.bodyColor,
      cardColor: p.cardColor,
      popoverColor: p.popoverColor,
      modalColor: p.modalColor,
      tableColor: p.tableColor,
      tableHeaderColor: p.tableHeaderColor,
      hoverColor: p.hoverColor,
      actionColor: p.actionColor,

      // === 边框/分割线 ===
      borderColor: p.borderColor,
      dividerColor: p.dividerColor,

      // === 圆角（对齐 --murasaki-radius-sm/md）===
      borderRadius: RADIUS_MD,
      borderRadiusSmall: RADIUS_SM,

      // === 字体（对齐 --murasaki-font-ui / --murasaki-font-mono）===
      fontFamily: FONT_UI,
      fontFamilyMono: FONT_MONO,
      fontSize: FONT_SIZE_BASE,
      fontWeight: FONT_WEIGHT,
      fontWeightStrong: FONT_WEIGHT_STRONG,

      // === 阴影（对齐 --murasaki-shadow-sm/md/lg）===
      boxShadow1: SHADOW[1],
      boxShadow2: SHADOW[2],
      boxShadow3: SHADOW[3],
    },

    Popover: {
      color: p.popoverColor,
      textColor: p.popoverForegroundColor,
      borderRadius: RADIUS_MD,
      boxShadow: SHADOW[3],
    },
  };
}

/**
 * naive-ui 主题 composable（仅浅色模式）。
 *
 * @param _uiMode 已废弃的 UI 模式引用（保留参数以兼容调用方签名）
 */
export function useNaiveTheme(_uiMode?: Ref<unknown>): {
  theme: Ref<GlobalTheme | null>;
  themeOverrides: Ref<GlobalThemeOverrides>;
} {
  const theme = computed<GlobalTheme | null>(() => lightTheme);
  const themeOverrides = computed<GlobalThemeOverrides>(() =>
    createMurasakiThemeOverrides()
  );

  return { theme, themeOverrides };
}
