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
import { sanitizeInlineHtml } from "../editor/wysiwyg/htmlSanitizer";
import { resolveImageSrc } from "../utils/imagePath";

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

    if (lang === "plantuml") {
      // 占位：由前端动态加载官方 plantuml.js（TeaVM 纯浏览器产物）异步渲染 SVG。
      // 源码以转义文本存于 div 内，渲染时读取 textContent。
      return `<div class="plantuml-block"${lineAttr}>${md.utils.escapeHtml(code)}</div>`;
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
 * 图片 src 解析插件（ADR-0015 / issue #118）。
 *
 * 覆盖 markdown-it 默认 image renderer，在渲染 <img> 前用 resolveImageSrc 转换 src：
 * - 相对/绝对本地路径 → tauri://localhost/... 协议 URL（Tauri WebView 可加载）
 * - URL / Base64 → 原样保留
 *
 * 通过模块级 currentFilePath 状态获取当前文件路径（由 setCurrentFilePath 设置）。
 */
function imageSrcPlugin(md: MarkdownIt) {
  md.renderer.rules.image = (tokens, idx, options, _env, self) => {
    const token = tokens[idx];
    const src = token.attrGet("src") ?? "";
    const resolved = resolveImageSrc(src, currentFilePath);
    if (resolved !== src) {
      token.attrSet("src", resolved);
    }
    // alt 属性必须设置（即使为空），复用默认行为
    // token.children 可能为 null（无 alt 文本），传入空数组以保持类型安全
    token.attrSet("alt", self.renderInlineAsText(token.children ?? [], options, _env));
    return self.renderToken(tokens, idx, options);
  };
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
 * 当前文件路径（模块级状态）。
 * 供 image renderer 与 WYSIWYG ImageWidget 解析相对图片路径使用（ADR-0015）。
 *
 * 由 PreviewPane / SourceEditor 在切换文件时通过 setCurrentFilePath() 设置。
 * 单例 renderer 在 render() 时读取此状态解析图片 src。
 */
let currentFilePath: string | null = null;

export function setCurrentFilePath(path: string | null): void {
  currentFilePath = path;
}

export function getCurrentFilePath(): string | null {
  return currentFilePath;
}

/**
 * T6.3 (#101)：配置脚注原位渲染。
 *
 * 默认 markdown-it-footnote 的 footnote_tail 核心规则会把所有脚注定义收集到文末
 * 汇聚成 footnotes-list。本函数禁用该行为，改为在定义出现的原位渲染为脚注块。
 *
 * 实现：
 * 1. 禁用 footnote_tail 核心规则 → 定义 token（footnote_reference_open/close）留在原位
 * 2. 覆写 footnote_ref 渲染器 → href 使用 label（#fn-{label}），与定义 id 对应
 * 3. 新增 footnote_reference_open 渲染器 → <div class="footnote-def" id="fn-{label}">
 * 4. 新增 footnote_reference_close 渲染器 → </div>
 *
 * 点击引用 → 通过 href="#fn-{label}" 跳转到原位定义。
 */
function configureFootnoteInline(md: MarkdownIt): void {
  // 1. 禁用 footnote_tail（文末汇聚）
  md.core.ruler.disable("footnote_tail");

  // 2. 覆写 footnote_ref 渲染器：使用 label 作为 id（与定义对应）
  md.renderer.rules.footnote_ref = (tokens, idx) => {
    const label = String(tokens[idx].meta.label);
    const id = `fn-${label}`;
    const refId = `fnref-${label}`;
    const subId = tokens[idx].meta.subId;
    const refIdFull = subId > 0 ? `${refId}:${subId}` : refId;
    const n = Number(tokens[idx].meta.id + 1).toString();
    return `<sup class="footnote-ref"><a href="#${id}" id="${refIdFull}">[${n}]</a></sup>`;
  };

  // 3. footnote_reference_open → 原位渲染为脚注定义容器
  md.renderer.rules.footnote_reference_open = (tokens, idx) => {
    const label = String(tokens[idx].meta.label);
    return `<div class="footnote-def" id="fn-${label}">`;
  };

  // 4. footnote_reference_close → 关闭容器（含返回引用的 backref）
  //    close token 无 meta.label，用闭包变量从对应 open token 传递
  md.renderer.rules.footnote_reference_close = (tokens, idx) => {
    // 向后查找对应的 footnote_reference_open 获取 label
    let label = "";
    for (let i = idx - 1; i >= 0; i--) {
      if (tokens[i].type === "footnote_reference_open") {
        label = String(tokens[i].meta.label);
        break;
      }
    }
    return ` <a href="#fnref-${label}" class="footnote-backref">\u21a9\ufe0e</a></div>`;
  };
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
  // T6.3 (#101)：脚注原位渲染 —— 禁用 footnote_tail（文末汇聚），改为在定义位置原位渲染
  configureFootnoteInline(md);
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
  // ADR-0015：图片 src 转换（本地路径 → tauri://localhost 协议）
  imageSrcPlugin(md);

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
    // T6.4 (#103)：净化 HTML 输出 —— markdown-it 配置 html:true 会原样透传内联 HTML，
    // 此处用 DOMPurify 清除 script/iframe/on*/javascript: 等 XSS 向量。
    // 覆盖 PreviewPane 预览 + useHtmlExport 导出（均调用 render()）。
    // data-source-line / data-lang 等 data-* 属性保留（DOMPurify 默认允许）。
    return sanitizeInlineHtml(getMd().render(source));
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
