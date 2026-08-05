/**
 * WYSIWYG 装饰系统（Ticket #72 / T7.1, #76 / T7.2）。
 *
 * 架构（ADR-0008）：StateField 提供装饰 + 轻量 ViewPlugin 监听语法树变化。
 *
 * 为什么不用单一 ViewPlugin？
 * - CM6 限制：ViewPlugin 不允许提供跨换行的块级替换装饰
 *   （"Decorations that replace line breaks may not be specified via plugins"）。
 *   代码块 / 表格 / Mermaid 等块级 widget 需要替换多行范围，必须用 StateField。
 * - StateField 通过 `EditorView.decorations.from(f)` 提供装饰，不受此限制。
 *
 * T7.1：行级标记 hide/dim + 列表 bullet / 分隔线 hr widget + 引用块左边框。
 * T7.2：块级 widget —— 代码块 Shiki 高亮 / 链接锚文本 / 图片 / 表格 / 数学 KaTeX / Mermaid SVG。
 *
 * Decoration 计算逻辑提取为纯函数 computeDecorations（便于单元测试），本文件负责：
 * - 把描述符转换为 CodeMirror DecorationSet（StateField.create / update）
 * - 监听 selection / doc / 提案 / 语法树变化（同步重算）
 * - Agent 提案覆盖范围不隐藏标记（提案优先级高于 WYSIWYG 隐藏）
 *
 * 详见 ADR-0008（CodeMirror 6 内 WYSIWYG / Typora 路线）。
 */
import { EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet, WidgetType } from "@codemirror/view";
import { EditorState, StateField, StateEffect } from "@codemirror/state";
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { codeToHtml } from "shiki";
import katex from "katex";
import mermaid from "mermaid";
import {
  proposalField,
  addProposalEffect,
  removeProposalEffect,
  expireAllProposalsEffect,
  proposalActionEffect,
} from "../../agent/proposals";
import { currentShikiTheme, getMarkdownRenderer, resolveShikiThemeOption, getCurrentFilePath } from "../../composables/useMarkdownRenderer";
import {
  computeDecorations,
  getParagraphRange,
  ComputedDeco,
  BlockWidgetDeco,
} from "./computeDecorations";
import { findEmojiShortcodesInRange } from "./emojiReplacement";
import { sanitizeInlineHtml } from "./htmlSanitizer";
import { renderFrontMatterCard } from "../../composables/useFrontMatter";
import { resolveImageSrc } from "../../utils/imagePath";

// ===== T7.1 Widgets =====

/** 无序列表 bullet（替换 `-`/`*`/`+` 标记）。 */
class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "murasaki-wysiwyg-bullet";
    span.textContent = "•";
    return span;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** 有序列表编号 widget（替换 `1.`/`a.` 标记）。离开段落时替换，避免光标定位到序号前。 */
class OrderedListWidget extends WidgetType {
  constructor(private label: string) {
    super();
  }
  eq(other: OrderedListWidget): boolean {
    return other.label === this.label;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "murasaki-wysiwyg-bullet murasaki-wysiwyg-ordered";
    span.textContent = this.label;
    return span;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** 分隔线（替换 `---`/`***`/`___`）。 */
class HrWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const hr = document.createElement("hr");
    hr.className = "murasaki-wysiwyg-hr";
    return hr;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * 任务列表复选框 widget：替换 `- [ ]` / `- [x]` 的 ListMark + TaskMarker。
 *
 * 点击切换勾选状态：直接修改底层 markdown 文本（[ ] ↔ [x]），
 * 通过 CustomEvent 通知 SourceEditor dispatch changes。
 */
class TaskCheckboxWidget extends WidgetType {
  constructor(private checked: boolean, private from: number, private to: number) {
    super();
  }
  eq(other: TaskCheckboxWidget): boolean {
    return other.checked === this.checked;
  }
  toDOM(): HTMLElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "murasaki-wysiwyg-task-checkbox"; // markdown-content.css: input[type="checkbox"] 提供视觉样式
    input.checked = this.checked;
    // 点击切换：发出自定义事件，SourceEditor 监听后 dispatch changes 修改 markdown
    input.addEventListener("click", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // 发出事件，携带替换信息，SourceEditor 监听后 dispatch changes 修改 markdown
      // 携带切换后的 checked 状态，监听端据此生成 `- [x]` 或 `- [ ]`
      input.dispatchEvent(new CustomEvent("murasaki-toggle-task", {
        bubbles: true,
        detail: { from: this.from, to: this.to, checked: !this.checked },
      }));
    });
    return input;
  }
  // 不忽略 click（但上面的 handler 已经 preventDefault，CM 不会定位光标）
  ignoreEvent(event: Event): boolean {
    return event.type !== "click";
  }
}

// ===== T7.2 块级 Widgets =====

/**
 * 代码块 widget：替换整个 FencedCode，用 Shiki 异步高亮渲染。
 * toDOM 先返回 <pre><code> 占位，codeToHtml 完成后替换为高亮 HTML。
 * 占位阶段保持代码可读，避免视觉跳变。
 */
class CodeBlockWidget extends WidgetType {
  constructor(private lang: string, private code: string, private from: number) {
    super();
  }
  eq(other: CodeBlockWidget): boolean {
    return other.lang === this.lang && other.code === this.code;
  }
  toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "murasaki-wysiwyg-codeblock-wrapper code-block-wrapper";

    // 语言标签栏（issue #85 / T2）：有语言时显示，空语言不显示
    if (this.lang) {
      const label = document.createElement("div");
      label.className = "murasaki-wysiwyg-code-lang-label code-lang-label";
      label.textContent = this.lang;
      wrapper.appendChild(label);
    }

    const pre = document.createElement("pre");
    pre.className = "murasaki-wysiwyg-codeblock";
    const codeEl = document.createElement("code");
    if (this.lang) codeEl.className = `language-${this.lang}`;
    codeEl.textContent = this.code;
    pre.appendChild(codeEl);
    wrapper.appendChild(pre);
    // 异步 Shiki 高亮：完成后用高亮 HTML 替换占位 <pre>（保留 wrapper + 语言标签）
    void codeToHtml(this.code, { lang: this.lang || "text", theme: resolveShikiThemeOption(currentShikiTheme.value) })
      .then((html) => {
        if (!pre.isConnected) return;
        const tmp = document.createElement("div");
        tmp.innerHTML = html;
        const replacement = tmp.firstElementChild as HTMLElement | null;
        if (replacement) pre.replaceWith(replacement);
      })
      .catch(() => {
        // 未知语言或加载失败：保留 <pre><code> 占位
      });
    // 点击 widget：发出事件让 SourceEditor 把光标定位到块起始位置，触发原始 markdown 编辑
    wrapper.addEventListener("click", () => {
      wrapper.dispatchEvent(new CustomEvent("murasaki-focus-block", {
        bubbles: true,
        detail: { from: this.from },
      }));
    });
    return wrapper;
  }
  // click 由 widget 自己处理（定位光标），其他事件交给 CM
  ignoreEvent(event: Event): boolean {
    return event.type === "click";
  }
}

/**
 * Mermaid widget：替换 ```mermaid 代码块，用 mermaid.js 异步渲染 SVG。
 * toDOM 先返回带源码占位的容器，render 完成后注入 SVG。
 *
 * id 由调用方传入（来自 WysiwygPluginValue 实例计数器），保证 SVG id 唯一。
 */
class MermaidWidget extends WidgetType {
  constructor(private code: string, private id: string, private from: number) {
    super();
  }
  eq(other: MermaidWidget): boolean {
    return other.code === this.code;
  }
  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.className = "murasaki-wysiwyg-mermaid mermaid";
    // 占位：出错时显示源码，便于排错
    container.textContent = this.code;
    void mermaid
      .render(this.id, this.code)
      .then(({ svg }) => {
        if (container.isConnected) container.innerHTML = svg;
      })
      .catch(() => {
        // 渲染失败：保留源码占位
      });
    // 点击 widget：发出事件定位光标到块起始位置
    container.addEventListener("click", () => {
      container.dispatchEvent(new CustomEvent("murasaki-focus-block", {
        bubbles: true,
        detail: { from: this.from },
      }));
    });
    return container;
  }
  // click 由 widget 自己处理（定位光标），其他事件交给 CM
  ignoreEvent(event: Event): boolean {
    return event.type === "click";
  }
}

/**
 * 链接 widget：替换 [text](url)，渲染为蓝色下划线锚文本。
 *
 * 交互行为（对齐 PreviewPane 的链接处理 + Typora 的编辑模型）：
 * - Ctrl/Cmd+Click：打开链接。外部 URL → 系统浏览器（shell.open）；
 *   相对 .md 路径 → 通过 emit('open-internal') 在新 tab 打开（由父组件处理）
 * - 普通点击：不拦截，CM6 把光标定位到链接范围（让用户编辑原始 markdown）
 * - ignoreEvent 对 click 返回 false（让 CM 处理点击定位光标），但 click handler
 *   在 Ctrl/Cmd 按下时调用 preventDefault 阻止 CM 定位，转而打开链接
 */
class LinkWidget extends WidgetType {
  constructor(private text: string, private url: string) {
    super();
  }
  eq(other: LinkWidget): boolean {
    return other.text === this.text && other.url === this.url;
  }
  toDOM(): HTMLElement {
    const a = document.createElement("a");
    a.className = "murasaki-wysiwyg-link";
    a.textContent = this.text;
    a.href = this.url;
    a.title = this.url;
    // Ctrl/Cmd+Click 打开链接（与 PreviewPane 行为一致）
    a.addEventListener("click", async (e: MouseEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // 普通 click 交给 CM 定位光标
      e.preventDefault();
      e.stopPropagation();
      const href = this.url;
      // 外部 URL → 系统浏览器
      if (/^(https?:|ftp:|file:|mailto:|tel:)/i.test(href)) {
        try {
          const { open } = await import("@tauri-apps/plugin-shell");
          await open(href);
        } catch {
          window.open(href, "_blank");
        }
      }
      // 相对 .md 链接的内部跳交由父组件处理（通过自定义事件）
      // 这里发自定义事件，App.vue 监听后调用 openFile
      else {
        a.dispatchEvent(new CustomEvent("murasaki-open-internal", {
          bubbles: true,
          detail: href,
        }));
      }
    });
    return a;
  }
  // click 事件不忽略（让 CM 定位光标），其他事件忽略
  ignoreEvent(event: Event): boolean {
    return event.type !== "click" && event.type !== "mousedown" && event.type !== "mouseup";
  }
}

/** 图片 widget：替换 ![alt](url)，渲染为实际 <img>。 */
class ImageWidget extends WidgetType {
  /** 构造时解析好的 src（基于当前文件路径）。eq 比较此值，路径变化时触发重渲染。 */
  private resolvedSrc: string;

  constructor(private alt: string, url: string) {
    super();
    // ADR-0015：在构造时解析 src（而非 toDOM 时），这样 eq 比较解析后的值，
    // 当 currentFilePath 变化时（切 tab），新 widget 的 resolvedSrc 不同，
    // eq 返回 false，CM6 会调用 toDOM 重新渲染图片。
    this.resolvedSrc = resolveImageSrc(url, getCurrentFilePath());
  }
  eq(other: ImageWidget): boolean {
    return other.alt === this.alt && other.resolvedSrc === this.resolvedSrc;
  }
  toDOM(): HTMLElement {
    const img = document.createElement("img");
    img.className = "murasaki-wysiwyg-image";
    img.alt = this.alt;
    img.src = this.resolvedSrc;
    img.title = this.alt;
    return img;
  }
  // 不忽略事件：点击图片 widget 时 CM 把光标定位到图片范围
  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * 表格 widget：替换 Table 节点，用 markdown-it 渲染对齐表格 HTML。
 * 复用 useMarkdownRenderer 的 markdown-it 实例（含 markdown-it-multimd-table 对齐支持）。
 */
class TableWidget extends WidgetType {
  constructor(private source: string, private from: number) {
    super();
  }
  eq(other: TableWidget): boolean {
    return other.source === this.source;
  }
  toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "murasaki-wysiwyg-table";
    try {
      // T6.4 (#103)：表格单元格内可能含内联 HTML（markdown-it html:true 透传），
      // 注入 innerHTML 前用 sanitizeInlineHtml 净化防 XSS
      wrapper.innerHTML = sanitizeInlineHtml(getMarkdownRenderer().md.render(this.source));
    } catch {
      // 渲染失败：显示原始 markdown 源码
      wrapper.textContent = this.source;
    }
    // 点击 widget：发出事件定位光标到块起始位置
    wrapper.addEventListener("click", () => {
      wrapper.dispatchEvent(new CustomEvent("murasaki-focus-block", {
        bubbles: true,
        detail: { from: this.from },
      }));
    });
    return wrapper;
  }
  // click 由 widget 自己处理（定位光标），其他事件交给 CM
  ignoreEvent(event: Event): boolean {
    return event.type === "click";
  }
}

/**
 * 数学公式 widget：替换 $...$ / $$...$$，用 KaTeX 同步渲染。
 * displayMode=true → 块级 <div>；false → 行内 <span>。
 */
class MathWidget extends WidgetType {
  constructor(private expr: string, private displayMode: boolean, private from: number) {
    super();
  }
  eq(other: MathWidget): boolean {
    return other.expr === this.expr && other.displayMode === this.displayMode;
  }
  toDOM(): HTMLElement {
    const el = document.createElement(this.displayMode ? "div" : "span");
    // 块级公式追加 modifier class，便于在 wysiwygTheme 中区分块级居中样式（T6）
    el.className = this.displayMode
      ? "murasaki-wysiwyg-math murasaki-wysiwyg-math-block katex katex-display"
      : "murasaki-wysiwyg-math katex";
    try {
      el.innerHTML = katex.renderToString(this.expr, {
        displayMode: this.displayMode,
        throwOnError: false,
        strict: false,
      });
    } catch {
      // 渲染失败：显示原始表达式
      el.textContent = this.expr;
    }
    // 点击 widget：发出事件定位光标到块起始位置
    el.addEventListener("click", () => {
      el.dispatchEvent(new CustomEvent("murasaki-focus-block", {
        bubbles: true,
        detail: { from: this.from },
      }));
    });
    return el;
  }
  // click 由 widget 自己处理（定位光标），其他事件交给 CM
  ignoreEvent(event: Event): boolean {
    return event.type === "click";
  }
}

/**
 * Emoji shortcode widget：替换 `:smile:` 等短代码为实际 emoji 字符。
 * 行内 widget，显示 emoji unicode 字符，光标离开段时渲染。
 */
class EmojiWidget extends WidgetType {
  constructor(private emoji: string, private shortcode: string) {
    super();
  }
  eq(other: EmojiWidget): boolean {
    return other.shortcode === this.shortcode;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "murasaki-wysiwyg-emoji";
    span.textContent = this.emoji;
    span.title = `:${this.shortcode}:`; // hover 显示原始 shortcode
    return span;
  }
  // 不忽略事件：点击 emoji widget 时 CM 把光标定位到 shortcode 范围
  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Frontmatter 卡片 widget（T6.2 / #100）：替换文档起始的 `---\n...\n---` 为样式化卡片。
 *
 * 复用 useFrontMatter.renderFrontMatterCard 渲染卡片 HTML（与预览/导出视觉一致）。
 * 点击卡片发出 `murasaki-focus-frontmatter` 自定义事件，SourceEditor 监听后：
 *   - 切换编辑模式到 source（让用户直接编辑原始 YAML）
 *   - 把光标定位到 frontmatter 起始位置（from）
 *
 * 仅在光标离开 frontmatter 范围时生成此 widget（光标进入时显示原始文本可编辑）。
 */
class FrontmatterCardWidget extends WidgetType {
  constructor(private content: string, private from: number) {
    super();
  }
  eq(other: FrontmatterCardWidget): boolean {
    return other.content === this.content;
  }
  toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    // markdown-body class on editor container makes .front-matter-card selectors match
    wrapper.className = "murasaki-wysiwyg-frontmatter";
    // 复用预览/导出的卡片渲染（含 title/date/tags 字段样式化）
    wrapper.innerHTML = renderFrontMatterCard(this.content);
    // 点击卡片：发出事件让 SourceEditor 切源码模式并定位光标
    wrapper.addEventListener("click", () => {
      wrapper.dispatchEvent(new CustomEvent("murasaki-focus-frontmatter", {
        bubbles: true,
        detail: { from: this.from },
      }));
    });
    return wrapper;
  }
  // click 由 widget 自己处理（切模式 + 定位光标），其他事件交给 CM
  ignoreEvent(event: Event): boolean {
    return event.type === "click";
  }
}

/**
 * HTML 块 widget（T6.4 / #103）：替换 HTMLBlock/HTMLTag 节点为渲染后的 HTML。
 *
 * 行为：
 * - 光标离开 HTML 段 → widget 替换原始 HTML 文本，渲染实际样式（所见即所得）
 * - 光标进入 HTML 段 → 显示原始 HTML 文本可编辑（不渲染 widget）
 *
 * 安全：注入 innerHTML 前用 sanitizeInlineHtml 净化（DOMPurify），
 * 清除 script / iframe / on* 事件属性 / javascript: 协议等 XSS 向量。
 *
 * 点击 widget：发出 murasaki-focus-block 事件定位光标到块起始位置（与其他块 widget 一致）。
 */
class HtmlWidget extends WidgetType {
  constructor(private source: string, private from: number) {
    super();
  }
  eq(other: HtmlWidget): boolean {
    return other.source === this.source;
  }
  toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "murasaki-wysiwyg-html";
    // T6.4 (#103)：净化后注入 innerHTML —— 防止用户输入的 HTML 包含 XSS payload
    wrapper.innerHTML = sanitizeInlineHtml(this.source);
    // 点击 widget：发出事件定位光标到块起始位置
    wrapper.addEventListener("click", () => {
      wrapper.dispatchEvent(new CustomEvent("murasaki-focus-block", {
        bubbles: true,
        detail: { from: this.from },
      }));
    });
    return wrapper;
  }
  // click 由 widget 自己处理（定位光标），其他事件交给 CM
  ignoreEvent(event: Event): boolean {
    return event.type === "click";
  }
}

/** 根据块级 widget 描述符构造对应 WidgetType 实例。 */
function createBlockWidget(d: BlockWidgetDeco, nextMermaidId: () => string): WidgetType {
  switch (d.widget) {
    case "codeBlock":
      return new CodeBlockWidget(d.lang, d.code, d.from);
    case "mermaid":
      return new MermaidWidget(d.code, nextMermaidId(), d.from);
    case "link":
      return new LinkWidget(d.text, d.url);
    case "image":
      return new ImageWidget(d.alt, d.url);
    case "table":
      return new TableWidget(d.source, d.from);
    case "math":
      return new MathWidget(d.expr, d.displayMode, d.from);
    case "emoji":
      return new EmojiWidget(d.emoji, d.shortcode);
    case "frontmatter":
      return new FrontmatterCardWidget(d.content, d.from);
    case "html":
      return new HtmlWidget(d.source, d.from);
  }
}

// ===== 描述符 → CodeMirror Decoration =====

function toDecorationSet(decos: ComputedDeco[], nextMermaidId: () => string): DecorationSet {
  const ranges = decos.map((d) => {
    if (d.type === "mark") {
      const cls =
        d.kind === "hide" ? "murasaki-wysiwyg-mark-hide" : "murasaki-wysiwyg-mark-dim";
      return Decoration.mark({ class: cls }).range(d.from, d.to);
    }
    if (d.type === "replace") {
      let widget: WidgetType;
      if (d.widget === "bullet") {
        widget = new BulletWidget();
      } else if (d.widget === "hr") {
        widget = new HrWidget();
      } else if (d.widget === "orderedList") {
        widget = new OrderedListWidget(d.label ?? "");
      } else {
        // taskCheckbox：携带 checked 状态 + 范围（用于点击切换时定位）
        widget = new TaskCheckboxWidget(!!d.checked, d.from, d.to);
      }
      return Decoration.replace({ widget }).range(d.from, d.to);
    }
    if (d.type === "render") {
      return Decoration.mark({ class: d.cssClass }).range(d.from, d.to);
    }
    // blockWidget：用渲染 widget 替换原始 markdown
    return Decoration.replace({ widget: createBlockWidget(d, nextMermaidId) }).range(d.from, d.to);
  });
  return Decoration.set(ranges, true);
}

// ===== Agent 提案范围（提案覆盖的标记不隐藏） =====

function getProposalRanges(state: EditorState): Array<{ from: number; to: number }> {
  const set = state.field(proposalField, false);
  if (!set) return [];
  return set.proposals
    .filter((p) => p.status === "pending")
    .map((p) => ({ from: p.from, to: p.to }));
}

// ===== StateField：提供装饰（支持跨换行块级替换） =====

/**
 * Mermaid SVG id 计数器（模块级）。
 * StateField 是单例（每个 EditorState 一个），模块级计数器足够保证 id 唯一。
 */
let mermaidIdCounter = 0;
function nextMermaidId(): string {
  return `murasaki-mermaid-${mermaidIdCounter++}`;
}

/**
 * 显式触发装饰重算的 StateEffect。
 * 用于语法树异步解析完成时通知 StateField 重算（StateField.update 只在 transaction 时触发，
 * 而语法树解析完成不产生 transaction，需要 ViewPlugin 监听并 dispatch 此 effect）。
 */
export const recomputeWysiwygEffect = StateEffect.define<void>();

/**
 * 从 EditorState 计算 WYSIWYG DecorationSet（纯函数，无副作用）。
 *
 * 注意：此处不主动调用 ensureSyntaxTree 强制解析语法树。
 * 原因：在 StateField.create/update 内推进 ParseContext 会让语法树引用变化，
 * 又会触发 wysiwygSyntaxWatcher 的 dispatch，形成无限循环（曾导致 OOM）。
 * 语法树的异步解析由 CM6 内置的 parseWorker 在后台 requestIdleCallback 中完成，
 * 解析完成时 wysiwygSyntaxWatcher 会 dispatch recomputeWysiwygEffect 触发重算。
 * 因此本函数只读取当前已解析的语法树（可能不完整），不主动推进解析。
 *
 * 注意：StateField 无法访问 view.viewport，因此不做视口增量计算。
 * 大文档（>10000 行）场景下性能可接受（CM6 RangeSet 增量构建），
 * 如需优化可再引入 ViewPlugin 监听 viewport 并 dispatch effect。
 */
function computeDecorationsForState(state: EditorState): DecorationSet {
  const decos = computeDecorations({
    doc: state.doc.toString(),
    selectionHead: state.selection.main.head,
    tree: syntaxTree(state),
    proposalRanges: getProposalRanges(state),
    // StateField 不访问 viewport —— 全量计算（大文档性能可接受）
    viewport: undefined,
  });
  return toDecorationSet(decos, nextMermaidId);
}

/**
 * WYSIWYG StateField —— 提供所有 WYSIWYG 装饰。
 *
 * 通过 `EditorView.decorations.from(f)` 提供装饰，不受 ViewPlugin 的
 * "不能跨换行块级替换" 限制，因此可以渲染代码块/表格/Mermaid 等多行 widget。
 *
 * 重算时机：
 * - docChanged / selectionSet → 立即重算（光标移动改变段范围，标记 hide/dim 切换）
 * - 提案 effect（add/remove/expire/action）→ 重算（提案覆盖范围标记可见性变化）
 * - recomputeWysiwygEffect → 重算（语法树异步解析完成）
 * - 其他 → 映射现有装饰到新位置（保持 widget 实例，避免重渲染）
 */
export const wysiwygField = StateField.define<DecorationSet>({
  create(state) {
    return computeDecorationsForState(state);
  },
  update(decos, tr) {
    // docChanged 或 selection 变化 → 重算（光标移动改变段范围，标记 hide/dim 切换）
    // 注意：Transaction 没有 selectionSet 布尔属性（那是 ViewUpdate 的），
    // 用 tr.selection !== undefined 检测事务是否包含选区变化。
    if (tr.docChanged || tr.selection !== undefined) {
      return computeDecorationsForState(tr.state);
    }
    // 提案变化 → 重算
    if (
      tr.effects.some(
        (e) =>
          e.is(addProposalEffect) ||
          e.is(removeProposalEffect) ||
          e.is(expireAllProposalsEffect) ||
          e.is(proposalActionEffect)
      )
    ) {
      return computeDecorationsForState(tr.state);
    }
    // 显式重算 effect（语法树异步完成等）
    if (tr.effects.some((e) => e.is(recomputeWysiwygEffect))) {
      return computeDecorationsForState(tr.state);
    }
    // 其他事务：映射装饰到新位置（不重算，保持 widget 实例稳定）
    return decos.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ===== 轻量 ViewPlugin：监听语法树异步解析变化 =====

/**
 * 语法树监视器：当语法树异步解析从未完成变为完成时，dispatch recomputeWysiwygEffect
 * 通知 wysiwygField 重算装饰。
 *
 * 为什么需要这个？
 * - StateField.update 只在 transaction 时触发，但语法树解析完成不产生 transaction。
 * - 初次创建编辑器时，语法树可能未完整解析，FencedCode/Table/Link 等节点未被识别，
 *   导致 widget 不渲染。语法树解析完成后，需要触发重算。
 * - 此 ViewPlugin 不提供任何装饰（decorations 不返回），仅用于副作用 dispatch。
 *
 * 防循环策略（曾因循环导致 OOM）：
 *  - 不在 constructor 主动 ensureSyntaxTree（让 parseWorker 在后台自然解析）
 *  - 只在解析状态从「未完成 → 完成」时 dispatch 一次（wasDone=false && isDone=true）
 *    解析进行中的增量推进不再触发 dispatch，避免「解析→重算→推进解析→再触发」循环
 *  - 额外保留 16ms 防抖 + pending 标志作为兜底保护
 */
const wysiwygSyntaxWatcher = ViewPlugin.fromClass(
  class {
    /** 上次 dispatch recomputeWysiwygEffect 的时间戳（防抖，避免循环） */
    private lastDispatch = 0;
    /** 是否已有 pending microtask dispatch（避免重复调度） */
    private pending = false;

    constructor(_view: EditorView) {
      // 不主动 ensureSyntaxTree —— parseWorker 会在后台解析，完成后通过 update 通知。
    }
    update(u: ViewUpdate): void {
      // 语法树引用未变化 → 无需处理
      if (syntaxTree(u.startState) === syntaxTree(u.state)) return;
      // 只在解析状态从「未完成 → 完成」时 dispatch 一次。
      // 解析进行中的增量推进（wasDone=false && isDone=false）不触发，
      // 避免每次语法树变化都重算装饰导致循环累积内存。
      const wasDone = syntaxTreeAvailable(u.startState, u.startState.doc.length);
      const isDone = syntaxTreeAvailable(u.state, u.state.doc.length);
      if (!(!wasDone && isDone)) return;

      // 防抖兜底：同一 microtask 周期内只调度一次，且最少间隔 16ms
      const now = performance.now();
      if (this.pending || now - this.lastDispatch < 16) return;
      this.pending = true;
      this.lastDispatch = now;

      const view = u.view;
      // CM6 禁止在 plugin update 内同步 dispatch（会抛错并停用 plugin），
      // 用 microtask 延迟到 update 周期外。T6.1 的 emoji 替换会改变 doc
      // 从而触发语法树重解析，此处必须异步以避免崩溃。
      queueMicrotask(() => {
        this.pending = false;
        view.dispatch({ effects: recomputeWysiwygEffect.of() });
      });
    }
    destroy(): void {
      // nothing to clean up
    }
  }
);

// ===== T6.1：Emoji 短代码源码替换 =====

/**
 * 从语法树收集代码范围（FencedCode / CodeBlock / InlineCode），
 * 用于排除这些范围内的 emoji shortcode 替换。
 */
function collectCodeRanges(state: EditorState): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  syntaxTree(state).iterate({
    enter(ref) {
      if (ref.name === "FencedCode" || ref.name === "CodeBlock" || ref.name === "InlineCode") {
        ranges.push({ from: ref.from, to: ref.to });
      }
    },
  });
  return ranges;
}

/**
 * Emoji 源码替换 ViewPlugin（issue #99 / T6.1）。
 *
 * 行为：WYSIWYG 模式下，光标离开当前段时，把段内 `:shortcode:` 替换为实际 emoji
 * 字符写入源码（非仅视觉隐藏）。源码/分屏模式不加载此 plugin（由 wysiwygComp 控制）。
 *
 * 触发时机：selectionSet 或 docChanged，且光标当前位置在 lastPara 范围之外。
 * 替换后置空 lastPara，由下一个 update 重新计算，避免位置偏移导致的误触发。
 *
 * 实现注意：CM6 不允许在 plugin update 内同步调用 view.dispatch（会抛
 * "Calls to EditorView.update are not allowed while an update is in progress"
 * 并停用 plugin）。因此用 queueMicrotask 把 dispatch 延迟到 update 周期之外。
 *
 * 仅替换段范围内、非代码范围、且 shortcode 映射有效的 `:name:` 文本。
 */
const emojiSourceReplacer = ViewPlugin.fromClass(
  class {
    private lastPara: { from: number; to: number } | null = null;

    constructor(view: EditorView) {
      this.lastPara = getParagraphRange(
        view.state.doc.toString(),
        view.state.selection.main.head
      );
    }

    update(u: ViewUpdate): void {
      if (!u.selectionSet && !u.docChanged) return;
      const doc = u.state.doc.toString();
      const head = u.state.selection.main.head;
      const currentPara = getParagraphRange(doc, head);

      if (this.lastPara) {
        const leftPara = head < this.lastPara.from || head > this.lastPara.to;
        if (leftPara) {
          const codeRanges = collectCodeRanges(u.state);
          const replacements = findEmojiShortcodesInRange(
            doc,
            this.lastPara.from,
            this.lastPara.to,
            codeRanges
          );
          if (replacements.length > 0) {
            const changes = replacements.map((r) => ({
              from: r.from,
              to: r.to,
              insert: r.emoji,
            }));
            const view = u.view;
            // 置空 lastPara：dispatch 触发的下一个 update 会重新计算，
            // 避免使用本次（已偏移的）位置
            this.lastPara = null;
            // CM6 禁止在 plugin update 内同步 dispatch，用 microtask 延迟到周期外
            queueMicrotask(() => {
              view.dispatch({
                changes,
                userEvent: "input.replaceEmoji",
              });
            });
            return;
          }
        }
      }

      this.lastPara = currentPara;
    }

    destroy(): void {
      this.lastPara = null;
    }
  }
);

/**
 * WYSIWYG 行为样式（仅 CM6 特有行为，视觉样式由 markdown-content.css 统一提供）。
 *
 * 0.5.0（issue #116）：移除了所有与 markdown-content.css 重复的视觉样式规则。
 * WYSIWYG 模式下编辑器容器带 .markdown-body class，markdown-content.css 的选择器
 * 直接匹配 widget 内的原生 HTML 标签和工具类。
 */
export const wysiwygTheme = EditorView.theme({
  ".murasaki-wysiwyg-mark-hide": {
    display: "none",
  },
  ".murasaki-wysiwyg-mark-dim": {
    opacity: "0.4",
    fontSize: "80%",
  },
  // 引用块：CM6 mark decoration 样式（无法用 <blockquote> 标签，需独立样式）
  // 引用 --md-* 变量与 markdown-content.css 保持视觉一致
  ".murasaki-wysiwyg-blockquote": {
    borderLeft: "3px solid var(--md-quote-border, var(--murasaki-purple-300, #d8b4fe))",
    background: "var(--md-quote-bg, var(--murasaki-purple-50, #faf5ff))",
    color: "var(--md-quote-color, var(--murasaki-muted-foreground, #737373))",
    fontStyle: "var(--md-quote-style, italic)",
    padding: "10px 16px",
    borderRadius: "0 var(--murasaki-radius-sm, 4px) var(--murasaki-radius-sm, 4px) 0",
  },
  ".murasaki-wysiwyg-bullet": {
    color: "var(--md-list-marker-color, var(--murasaki-primary, #9333ea))",
    paddingRight: "6px",
    userSelect: "none",
  },
  // 标题排版：与 markdown-content.css 的 .markdown-body h1-h6 保持一致（issue：WYSIWYG 与预览视觉统一）
  ".murasaki-wysiwyg-h1": {
    fontSize: "22px", fontWeight: "700", letterSpacing: "-0.02em", lineHeight: "1.3", color: "var(--md-heading-color)",
  },
  ".murasaki-wysiwyg-h2": {
    fontSize: "18px", fontWeight: "700", letterSpacing: "-0.01em", lineHeight: "1.35", color: "var(--md-heading-color)",
  },
  ".murasaki-wysiwyg-h3": {
    fontSize: "15px", fontWeight: "600", lineHeight: "1.4", color: "var(--md-heading-color)",
  },
  ".murasaki-wysiwyg-h4": {
    fontSize: "14px", fontWeight: "600", lineHeight: "1.4", color: "var(--md-heading-color)",
  },
  ".murasaki-wysiwyg-h5": {
    fontSize: "13px", fontWeight: "600", lineHeight: "1.4", color: "var(--md-heading-color-2)",
  },
  ".murasaki-wysiwyg-h6": {
    fontSize: "12px", fontWeight: "600", lineHeight: "1.4", color: "var(--md-heading-color-3)",
    textTransform: "uppercase", letterSpacing: "0.05em",
  },
  // 行为样式：cursor / userSelect 等（视觉由 markdown-content.css 提供）
  ".murasaki-wysiwyg-task-checkbox": {
    cursor: "pointer",
    userSelect: "none",
  },
  ".murasaki-wysiwyg-link": {
    cursor: "text",
  },
  ".murasaki-wysiwyg-frontmatter": {
    cursor: "pointer",
    margin: "0 0 16px",
  },
  ".murasaki-wysiwyg-html": {
    cursor: "text",
    margin: "8px 0",
  },
  ".murasaki-wysiwyg-mermaid svg": {
    maxWidth: "100%",
    height: "auto",
  },
});

/**
 * 一键启用 WYSIWYG：StateField（提供装饰）+ 语法树监视 ViewPlugin + emoji 源码替换器 + 主题。
 *
 * 在 SourceEditor.vue 中通过 Compartment 按模式（source/split/wysiwyg）叠加/移除。
 * - wysiwygField：StateField，提供所有 WYSIWYG 装饰（含跨换行块级 widget）
 * - wysiwygSyntaxWatcher：ViewPlugin，监听语法树异步解析并触发重算（不提供装饰）
 * - emojiSourceReplacer：ViewPlugin，光标离段时把 :shortcode: 替换为 emoji 写入源码（T6.1）
 * - wysiwygTheme：EditorView.theme，WYSIWYG 样式
 */
export const wysiwygExtensions = [
  wysiwygField,
  wysiwygSyntaxWatcher,
  emojiSourceReplacer,
  wysiwygTheme,
];