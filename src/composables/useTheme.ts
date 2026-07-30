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
 * Markdown 预览主题列表（见 spec Implementation Decisions + issue #84 Murasaki 主题）。
 * Shiki 主题选用官方内置的 light/dark 变体，保证开箱可用。
 *
 * Murasaki 主题（紫色品牌色）为默认主题，深色代码块背景由 CSS 变量
 * --md-codeblock-bg 控制。issue #85 起 Murasaki 主题改用自定义品牌紫色系 Shiki
 * 主题对象（见 useMarkdownRenderer.ts 的 murasakiShikiTheme），通过 "murasaki"
 * 哨兵值触发，其他主题仍用官方内置 light/dark 变体。
 */
export const MARKDOWN_THEMES: MarkdownTheme[] = [
  {
    name: "murasaki",
    label: "Murasaki",
    shikiTheme: "murasaki",
    isDark: false,
  },
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

/** 默认主题（Murasaki 紫色品牌色） */
export const DEFAULT_THEME = "murasaki";

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
