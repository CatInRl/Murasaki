import { ref, computed, watch, onMounted, onBeforeUnmount, type Ref } from "vue";
import { lightTheme, darkTheme, type GlobalTheme, type GlobalThemeOverrides } from "naive-ui";

/**
 * naive-ui themeOverrides 对齐 --murasaki-* token（ADR-0005）。
 *
 * 把 naive-ui 的颜色/圆角/字体变量映射到 Murasaki 设计系统的 token，
 * 使 naive-ui 组件在浅色/深色模式下都与应用品牌色一致，保留 naive-ui 的
 * 可访问性/键盘导航/焦点管理行为。
 *
 * 颜色值与 [src/styles/theme.css] 中的 --murasaki-* token 严格对应。
 */

export type UiMode = "light" | "dark" | "system";
export type EffectiveMode = "light" | "dark";

/** UI 模式字体（来自 --murasaki-font-ui） */
const FONT_UI =
  '"Inter", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
/** UI 模式等宽字体（来自 --murasaki-font-mono） */
const FONT_MONO =
  '"JetBrains Mono", "Fira Code", "Cascadia Code", "Consolas", monospace';

/** 紫色品牌色板（浅色/深色通用，来自 --murasaki-purple-*） */
const PURPLE = {
  400: "#c084fc",
  500: "#a855f7",
  600: "#9333ea",
  700: "#7e22ce",
} as const;

/** 状态色（来自 --murasaki-state-*，浅色/深色通用） */
const STATE = {
  success: "#16a34a",
  warning: "#d97706",
  error: "#dc2626",
  info: "#2563eb",
} as const;

/** 圆角（来自 --murasaki-radius-sm/md） */
const RADIUS_SM = "4px";
const RADIUS_MD = "8px";

/** 阴影（来自 --murasaki-shadow-sm/md/lg，浅色/深色通用） */
const SHADOW = {
  1: "0 1px 2px rgba(15, 23, 42, 0.04)",
  2: "0 4px 12px rgba(15, 23, 42, 0.08)",
  3: "0 12px 32px rgba(15, 23, 42, 0.12)",
} as const;

/** 字号/字重（来自 spec 议题簇 0 token 补全：--murasaki-text-base = 14px） */
const FONT_SIZE_BASE = "14px";
const FONT_WEIGHT = "400";
const FONT_WEIGHT_STRONG = "600";

/** 模式相关的表面/文字/边框调色板，对齐 --murasaki-* 语义 token */
interface ModePalette {
  /** --murasaki-background */
  bodyColor: string;
  /** --murasaki-card */
  cardColor: string;
  /** --murasaki-popover */
  popoverColor: string;
  /** --murasaki-popover-foreground */
  popoverForegroundColor: string;
  /** 模态背景，对齐 --murasaki-popover */
  modalColor: string;
  /** --murasaki-surface */
  tableColor: string;
  /** --murasaki-surface-2 / --murasaki-muted */
  tableHeaderColor: string;
  /** --murasaki-muted */
  hoverColor: string;
  /** 表格操作区背景，对齐 --murasaki-muted */
  actionColor: string;
  /** --murasaki-border */
  borderColor: string;
  /** --murasaki-line */
  dividerColor: string;
  /** --murasaki-foreground / --murasaki-ink */
  textColorBase: string;
  textColor1: string;
  /** --murasaki-ink-2 */
  textColor2: string;
  /** --murasaki-muted-foreground */
  textColor3: string;
  /** 占位符色，对齐 --murasaki-ink-3 */
  placeholderColor: string;
}

const LIGHT_PALETTE: ModePalette = {
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

const DARK_PALETTE: ModePalette = {
  bodyColor: "#0f0f14",
  cardColor: "#18181f",
  popoverColor: "#1c1c24",
  popoverForegroundColor: "#e5e7eb",
  modalColor: "#1c1c24",
  tableColor: "#16161d",
  tableHeaderColor: "#1f1f28",
  hoverColor: "#1f1f28",
  actionColor: "#1f1f28",
  borderColor: "#2a2a35",
  dividerColor: "#2a2a35",
  textColorBase: "#e5e7eb",
  textColor1: "#e5e7eb",
  textColor2: "#b3b3c0",
  textColor3: "#9ca3af",
  placeholderColor: "#6b6b7c",
};

/**
 * 将 UI 模式 + 系统偏好解析为最终生效的浅色/深色模式。
 *
 * - `light` / `dark`：显式覆盖系统偏好
 * - `system`：跟随操作系统 prefers-color-scheme
 *
 * 纯函数，无副作用，可单元测试。
 */
export function resolveEffectiveMode(
  uiMode: UiMode,
  systemDark: boolean
): EffectiveMode {
  if (uiMode === "system") return systemDark ? "dark" : "light";
  return uiMode;
}

/**
 * 读取当前系统是否为深色模式（prefers-color-scheme: dark）。
 * 在非浏览器环境（SSR/无 matchMedia）下返回 false。
 */
function readSystemDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * 把 effective mode 映射为 <html data-theme> 属性，使 --murasaki-* token
 * 与 naive-ui 主题保持一致：
 * - `system` → 移除 data-theme，由 CSS media query 自动决定
 * - `light` / `dark` → 显式设置 data-theme 覆盖系统偏好
 */
function applyDataTheme(uiMode: UiMode): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (uiMode === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", uiMode);
  }
}

/**
 * 根据 mode 生成 naive-ui GlobalThemeOverrides，颜色/圆角/字体变量映射到
 * --murasaki-* token。
 *
 * 纯函数，无副作用：相同 mode 输入始终返回等价配置，可单元测试断言输出。
 * NPopover 的组件级 overrides 在 T5.1 补全（issue #71）。
 */
export function createMurasakiThemeOverrides(
  mode: EffectiveMode
): GlobalThemeOverrides {
  const p = mode === "dark" ? DARK_PALETTE : LIGHT_PALETTE;
  return {
    common: {
      // === 品牌主色（紫色，浅色/深色通用）===
      primaryColor: PURPLE[600],
      primaryColorHover: PURPLE[400],
      primaryColorPressed: PURPLE[700],
      primaryColorSuppl: PURPLE[500],

      // === 状态色（浅色/深色通用）===
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

    // === NPopover 组件级 overrides（T5.1, issue #71）===
    // 浮层背景/文字/圆角/阴影对齐 --murasaki-* token。
    // borderColor 不适用：naive-ui NPopover 默认无边框，靠 boxShadow 表达层级。
    Popover: {
      color: p.popoverColor,
      textColor: p.popoverForegroundColor,
      borderRadius: RADIUS_MD,
      boxShadow: SHADOW[3],
    },
  };
}

/**
 * naive-ui 主题响应式 composable。
 *
 * 监听 uiMode 设置 + 系统主题变化，返回当前应使用的 naive-ui theme 与
 * themeOverrides，并把 data-theme 同步到 <html>，使 --murasaki-* token 与
 * naive-ui 组件在浅色/深色切换时保持一致。
 *
 * @param uiMode 响应式 UI 模式（通常来自持久化设置）
 */
export function useNaiveTheme(uiMode: Ref<UiMode>): {
  effectiveMode: Ref<EffectiveMode>;
  theme: Ref<GlobalTheme | null>;
  themeOverrides: Ref<GlobalThemeOverrides>;
} {
  const systemDark = ref(readSystemDark());
  let mql: MediaQueryList | null = null;
  const onMediaChange = (e: MediaQueryListEvent): void => {
    systemDark.value = e.matches;
  };

  onMounted(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    mql = window.matchMedia("(prefers-color-scheme: dark)");
    mql.addEventListener("change", onMediaChange);
    systemDark.value = mql.matches;
  });

  onBeforeUnmount(() => {
    mql?.removeEventListener("change", onMediaChange);
    mql = null;
  });

  const effectiveMode = computed<EffectiveMode>(() =>
    resolveEffectiveMode(uiMode.value, systemDark.value)
  );
  const theme = computed<GlobalTheme | null>(() =>
    effectiveMode.value === "dark" ? darkTheme : lightTheme
  );
  const themeOverrides = computed<GlobalThemeOverrides>(() =>
    createMurasakiThemeOverrides(effectiveMode.value)
  );

  // 同步 data-theme 到 <html>：system 移除属性交由 CSS media query，light/dark 显式覆盖
  watch(uiMode, (mode) => applyDataTheme(mode), { immediate: true });

  return { effectiveMode, theme, themeOverrides };
}
