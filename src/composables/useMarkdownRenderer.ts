import { ref, shallowRef } from "vue";
import MarkdownIt from "markdown-it";
import { full as markdownItEmoji } from "markdown-it-emoji";
import markdownItFrontMatter from "markdown-it-front-matter";
import markdownItTaskLists from "markdown-it-task-lists";
import markdownItFootnote from "markdown-it-footnote";
import markdownItSub from "markdown-it-sub";
import markdownItSup from "markdown-it-sup";
import markdownItIns from "markdown-it-ins";
import markdownItMark from "markdown-it-mark";
import markdownItAbbr from "markdown-it-abbr";
import markdownItContainer from "markdown-it-container";
import markdownItMultimdTable from "markdown-it-multimd-table";
import markdownItTexmath from "markdown-it-texmath";
import katex from "katex";
import { codeToHtml, type ThemeRegistration } from "shiki";
import { getCurrentTheme } from "./useTheme";

/**
 * 当前 Shiki 主题（与 Markdown 主题联动）。
 * 通过 setShikiTheme 切换，切换后需要重新高亮已渲染的代码块。
 */
let currentShikiThemeName = getCurrentTheme().shikiTheme;

/**
 * Murasaki 品牌色 Shiki 主题（issue #85 / T2）。
 * 对齐设计稿 ux-markdown-structures.html:543 的语法色：
 *  - keyword / storage：#c084fc（紫，品牌主色系）
 *  - function / type：#60a5fa（蓝）
 *  - string：#4ade80（绿）
 *  - comment：#6b7280 italic（灰斜体）
 *  - variable：#e5e7eb（深色代码块前景）
 *  - number / boolean：#2563eb（info 蓝）
 *  - operator / punctuation：#6b7280（灰）
 *
 * 代码块背景为深色（--md-codeblock-bg: var(--murasaki-neutral-900)），故 type=dark，
 * variable 用深色模式前景 #e5e7eb。
 * 当 currentShikiThemeName === "murasaki" 时通过 resolveShikiThemeOption 传入。
 */
const murasakiShikiTheme: ThemeRegistration = {
  name: "murasaki",
  type: "dark",
  colors: {
    "editor.background": "#171717",
    "editor.foreground": "#e5e7eb",
  },
  fg: "#e5e7eb",
  bg: "#171717",
  tokenColors: [
    {
      scope: ["keyword", "storage.type", "storage.modifier"],
      settings: { foreground: "#c084fc" },
    },
    {
      scope: ["entity.name.function", "support.function"],
      settings: { foreground: "#60a5fa" },
    },
    {
      scope: ["string", "string.quoted"],
      settings: { foreground: "#4ade80" },
    },
    {
      scope: ["comment"],
      settings: { foreground: "#6b7280", fontStyle: "italic" },
    },
    {
      scope: ["variable", "meta.variable"],
      settings: { foreground: "#e5e7eb" },
    },
    {
      scope: ["constant.numeric", "constant.language.boolean"],
      settings: { foreground: "#2563eb" },
    },
    {
      scope: [
        "entity.name.class",
        "entity.name.type",
        "support.type",
        "support.class",
      ],
      settings: { foreground: "#60a5fa" },
    },
    {
      scope: ["keyword.operator", "punctuation"],
      settings: { foreground: "#6b7280" },
    },
  ],
};

/**
 * 解析 Shiki 主题参数：murasaki 主题返回自定义 theme object，其他主题返回主题名字符串。
 * 供 highlightCodeBlocks / wysiwygPlugin / useHtmlExport 共用，确保 murasaki 主题走品牌色。
 */
export function resolveShikiThemeOption(
  themeName: string
): string | ThemeRegistration {
  if (themeName === "murasaki") return murasakiShikiTheme;
  return themeName;
}

/**
 * 自定义 fence 处理：
 *  - mermaid 块 → <div class="mermaid"> 占位，由前端 mermaid.run() 异步渲染
 *  - 其他语言 → 占位 <pre><code data-lang="...">，由 highlightCodeBlocks 异步替换为 Shiki 高亮 HTML
 *  - 同时注入 data-source-line 属性（基于 token.map），供滚动同步使用
 */
function codeBlockPlugin(md: MarkdownIt) {
  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const lang = token.info.trim();
    const code = token.content;
    const lineAttr = token.map
      ? ` data-source-line="${token.map[0] + 1}"`
      : "";

    if (lang === "mermaid") {
      return `<div class="mermaid"${lineAttr}>${md.utils.escapeHtml(code)}</div>`;
    }

    // 同步占位：返回原始 <pre><code>，后续由 highlightCodeBlocks 异步替换
    const escapedCode = md.utils.escapeHtml(code);
    const langAttr = lang ? ` data-lang="${md.utils.escapeHtml(lang)}"` : ' data-lang=""';
    const langClass = lang ? ` class="language-${lang}"` : "";
    const pre = `<pre${lineAttr}><code${langClass}${langAttr}>${escapedCode}</code></pre>`;
    // 有语言时包裹语言标签栏（issue #85 / T2）；语言为空则不显示标签栏
    if (lang) {
      return `<div class="code-block-wrapper"><div class="code-lang-label">${md.utils.escapeHtml(lang)}</div>${pre}</div>`;
    }
    return pre;
  };
}

/**
 * 滚动同步支持：为带有 map（源行号）的块级 token 注入 data-source-line 属性。
 * markdown-it 的 token.map 是 [startLine, endLine]（0-indexed），
 * 转为 1-indexed 后写入 data-source-line，供 useScrollSync 查找。
 */
function attachSourceLinePlugin(md: MarkdownIt) {
  const openTokens = [
    "paragraph_open",
    "heading_open",
    "bullet_list_open",
    "ordered_list_open",
    "list_item_open",
    "blockquote_open",
    "table_open",
    "hr",
  ] as const;

  for (const name of openTokens) {
    const original = md.renderer.rules[name];
    md.renderer.rules[name] = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      if (token.map) {
        token.attrSet("data-source-line", String(token.map[0] + 1));
      }
      if (original) {
        return original(tokens, idx, options, env, self);
      }
      return self.renderToken(tokens, idx, options);
    };
  }
}

/**
 * 最近一次解析的 YAML front-matter 原文。
 * 供前端渲染为卡片使用（见 spec：YAML frontmatter 必须解析并渲染为样式化卡片）。
 */
let lastFrontMatter = "";

export function getFrontMatter(): string {
  return lastFrontMatter;
}

/**
 * 创建带完整插件链的 markdown-it 实例。
 */
function createMarkdownIt(): MarkdownIt {
  // 重置状态
  lastFrontMatter = "";

  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    breaks: false,
  });

  md.use(markdownItEmoji);
  // front-matter 插件要求传入回调，回调会在解析到 front-matter 时被调用
  md.use(markdownItFrontMatter, (fm: string) => {
    lastFrontMatter = fm;
  });
  md.use(markdownItTaskLists, {
    enabled: true,
    label: true,
    labelAfter: true,
  });
  md.use(markdownItFootnote);
  md.use(markdownItSub);
  md.use(markdownItSup);
  md.use(markdownItIns);
  md.use(markdownItMark);
  md.use(markdownItAbbr);
  md.use(markdownItContainer, "warning");
  md.use(markdownItContainer, "info");
  md.use(markdownItContainer, "tip");
  md.use(markdownItContainer, "danger");
  md.use(markdownItMultimdTable, {
    multiline: true,
    rowspan: true,
    headerless: true,
    multibody: true,
  });
  md.use(markdownItTexmath, {
    engine: katexEngine,
    delimiters: "dollars",
    katexOptions: { throwOnError: false, strict: false },
  });
  md.use(codeBlockPlugin);
  // 为块级元素注入 data-source-line，供滚动同步使用
  attachSourceLinePlugin(md);

  return md;
}

/**
 * KaTeX 渲染桥：markdown-it-texmath 期望一个 renderToString 接口。
 */
function katexEngine(expr: string, opts: { displayMode?: boolean }) {
  return katex.renderToString(expr, {
    displayMode: opts.displayMode ?? false,
    throwOnError: false,
    strict: false,
  });
}

/**
 * 异步高亮 <pre><code data-lang="..."> 块。
 * 在 HTML 注入 DOM 后调用，把占位替换为 Shiki 高亮后的 HTML。
 * 使用当前 currentShikiThemeName 作为高亮主题。
 */
async function highlightCodeBlocks(container: HTMLElement) {
  const blocks = container.querySelectorAll<HTMLElement>(
    'pre code[data-lang]'
  );
  for (const block of Array.from(blocks)) {
    const lang = block.getAttribute("data-lang") || "text";
    const code = block.textContent || "";
    try {
      const html = await codeToHtml(code, {
        lang,
        theme: resolveShikiThemeOption(currentShikiThemeName),
      });
      const wrapper = document.createElement("div");
      wrapper.innerHTML = html;
      const replacement = wrapper.firstElementChild as HTMLElement | null;
      if (replacement) {
        block.parentElement?.replaceWith(replacement);
      }
    } catch {
      // 未知语言或加载失败时保留原始占位
    }
  }
}

export interface UseMarkdownRenderer {
  /** markdown-it 实例（同步可用，代码块为占位） */
  md: MarkdownIt;
  /** 同步渲染 HTML（代码块占位，Mermaid 占位） */
  render(source: string): string;
  /** DOM 渲染后异步替换代码块高亮 */
  highlight(container: HTMLElement): Promise<void>;
  /** 当前使用的 Shiki 主题名 */
  getShikiTheme(): string;
  /** 切换 Shiki 主题（切换后需重新 highlight 才生效） */
  setShikiTheme(theme: string): void;
}

export function useMarkdownRenderer(): UseMarkdownRenderer {
  const md = shallowRef<MarkdownIt | null>(null);

  function getMd(): MarkdownIt {
    if (!md.value) {
      md.value = createMarkdownIt();
    }
    return md.value;
  }

  function render(source: string): string {
    // 重置 front-matter 缓存：若文档含 front-matter，回调会重新赋值
    lastFrontMatter = "";
    return getMd().render(source);
  }

  async function highlight(container: HTMLElement) {
    await highlightCodeBlocks(container);
  }

  function getShikiTheme(): string {
    return currentShikiThemeName;
  }

  function setShikiTheme(theme: string): void {
    currentShikiThemeName = theme;
    currentShikiTheme.value = theme;
  }

  return {
    md: getMd(),
    render,
    highlight,
    getShikiTheme,
    setShikiTheme,
  };
}

// 单例缓存
let singleton: UseMarkdownRenderer | null = null;
export function getMarkdownRenderer(): UseMarkdownRenderer {
  if (!singleton) singleton = useMarkdownRenderer();
  return singleton;
}

// 响应式：当前 Shiki 主题（供组件 watch 触发重新高亮）
export const currentShikiTheme = ref<string>(currentShikiThemeName);
