import { ref } from "vue";

/**
 * Markdown 预览主题定义。
 *  - name: 主题标识（用于 CSS 类名 theme-<name>）
 *  - label: 显示名称
 *  - shikiTheme: 对应的 Shiki 代码高亮主题
 *  - isDark: 是否为暗色主题（影响容器背景/文字色）
 */
export interface MarkdownTheme {
  name: string;
  label: string;
  shikiTheme: string;
  isDark: boolean;
}

/**
 * 四套预设 Markdown 主题（见 spec Implementation Decisions）。
 * Shiki 主题选用官方内置的 light/dark 变体，保证开箱可用。
 */
export const MARKDOWN_THEMES: MarkdownTheme[] = [
  {
    name: "github",
    label: "GitHub",
    shikiTheme: "github-light",
    isDark: false,
  },
  {
    name: "newsprint",
    label: "Newsprint",
    shikiTheme: "github-light",
    isDark: false,
  },
  {
    name: "night",
    label: "Night",
    shikiTheme: "github-dark",
    isDark: true,
  },
  {
    name: "academic",
    label: "Academic",
    shikiTheme: "github-light",
    isDark: false,
  },
];

/** 默认主题 */
export const DEFAULT_THEME = "github";

/** 当前激活的 Markdown 主题（响应式，供组件 watch） */
const currentTheme = ref<string>(DEFAULT_THEME);

/** 获取当前主题对象 */
export function getCurrentTheme(): MarkdownTheme {
  return (
    MARKDOWN_THEMES.find((t) => t.name === currentTheme.value) ??
    MARKDOWN_THEMES[0]
  );
}

/** 切换主题 */
export function setTheme(name: string): void {
  if (MARKDOWN_THEMES.some((t) => t.name === name)) {
    currentTheme.value = name;
  }
}

/** 当前主题的响应式引用 */
export const themeRef = currentTheme;
