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
import { syntaxTree, ensureSyntaxTree } from "@codemirror/language";
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
import { currentShikiTheme, getMarkdownRenderer, resolveShikiThemeOption } from "../../composables/useMarkdownRenderer";
import {
  computeDecorations,
  ComputedDeco,
  BlockWidgetDeco,
} from "./computeDecorations";

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

/** 分隔线（替换 `---`/`***`/`___`）。 */
class HrWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const div = document.createElement("div");
    div.className = "murasaki-wysiwyg-hr";
    return div;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

// ===== T7.2 块级 Widgets =====

/**
 * 代码块 widget：替换整个 FencedCode，用 Shiki 异步高亮渲染。
 * toDOM 先返回 <pre><code> 占位，codeToHtml 完成后替换为高亮 HTML。
 * 占位阶段保持代码可读，避免视觉跳变。
 */
class CodeBlockWidget extends WidgetType {
  constructor(private lang: string, private code: string) {
    super();
  }
  eq(other: CodeBlockWidget): boolean {
    return other.lang === this.lang && other.code === this.code;
  }
  toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "murasaki-wysiwyg-codeblock-wrapper";

    // 语言标签栏（issue #85 / T2）：有语言时显示，空语言不显示
    if (this.lang) {
      const label = document.createElement("div");
      label.className = "murasaki-wysiwyg-code-lang-label";
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
    return wrapper;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Mermaid widget：替换 ```mermaid 代码块，用 mermaid.js 异步渲染 SVG。
 * toDOM 先返回带源码占位的容器，render 完成后注入 SVG。
 *
 * id 由调用方传入（来自 WysiwygPluginValue 实例计数器），保证 SVG id 唯一。
 */
class MermaidWidget extends WidgetType {
  constructor(private code: string, private id: string) {
    super();
  }
  eq(other: MermaidWidget): boolean {
    return other.code === this.code;
  }
  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.className = "murasaki-wysiwyg-mermaid";
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
    return container;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * 链接 widget：替换 [text](url)，渲染为蓝色下划线锚文本。
 * title 属性携带 url，光标 hover 显示完整 URL（光标进入段则回到原始 markdown 可编辑）。
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
    return a;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** 图片 widget：替换 ![alt](url)，渲染为实际 <img>。 */
class ImageWidget extends WidgetType {
  constructor(private alt: string, private url: string) {
    super();
  }
  eq(other: ImageWidget): boolean {
    return other.alt === this.alt && other.url === this.url;
  }
  toDOM(): HTMLElement {
    const img = document.createElement("img");
    img.className = "murasaki-wysiwyg-image";
    img.alt = this.alt;
    img.src = this.url;
    img.title = this.alt;
    return img;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * 表格 widget：替换 Table 节点，用 markdown-it 渲染对齐表格 HTML。
 * 复用 useMarkdownRenderer 的 markdown-it 实例（含 markdown-it-multimd-table 对齐支持）。
 */
class TableWidget extends WidgetType {
  constructor(private source: string) {
    super();
  }
  eq(other: TableWidget): boolean {
    return other.source === this.source;
  }
  toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "murasaki-wysiwyg-table";
    try {
      wrapper.innerHTML = getMarkdownRenderer().md.render(this.source);
    } catch {
      // 渲染失败：显示原始 markdown 源码
      wrapper.textContent = this.source;
    }
    return wrapper;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * 数学公式 widget：替换 $...$ / $$...$$，用 KaTeX 同步渲染。
 * displayMode=true → 块级 <div>；false → 行内 <span>。
 */
class MathWidget extends WidgetType {
  constructor(private expr: string, private displayMode: boolean) {
    super();
  }
  eq(other: MathWidget): boolean {
    return other.expr === this.expr && other.displayMode === this.displayMode;
  }
  toDOM(): HTMLElement {
    const el = document.createElement(this.displayMode ? "div" : "span");
    // 块级公式追加 modifier class，便于在 wysiwygTheme 中区分块级居中样式（T6）
    el.className = this.displayMode
      ? "murasaki-wysiwyg-math murasaki-wysiwyg-math-block"
      : "murasaki-wysiwyg-math";
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
    return el;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** 根据块级 widget 描述符构造对应 WidgetType 实例。 */
function createBlockWidget(d: BlockWidgetDeco, nextMermaidId: () => string): WidgetType {
  switch (d.widget) {
    case "codeBlock":
      return new CodeBlockWidget(d.lang, d.code);
    case "mermaid":
      return new MermaidWidget(d.code, nextMermaidId());
    case "link":
      return new LinkWidget(d.text, d.url);
    case "image":
      return new ImageWidget(d.alt, d.url);
    case "table":
      return new TableWidget(d.source);
    case "math":
      return new MathWidget(d.expr, d.displayMode);
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
      const widget = d.widget === "bullet" ? new BulletWidget() : new HrWidget();
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
 * 强制完整解析语法树（小文档同步完成；大文档 5s 超时回退到部分解析），
 * 避免 FencedCode/Table 等节点未识别导致 widget 不渲染。
 *
 * 注意：StateField 无法访问 view.viewport，因此不做视口增量计算。
 * 大文档（>10000 行）场景下性能可接受（CM6 RangeSet 增量构建），
 * 如需优化可再引入 ViewPlugin 监听 viewport 并 dispatch effect。
 */
function computeDecorationsForState(state: EditorState): DecorationSet {
  ensureSyntaxTree(state, state.doc.length + 1, 5000);
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
 * 语法树监视器：当语法树引用变化（异步解析完成）时，dispatch recomputeWysiwygEffect
 * 通知 wysiwygField 重算装饰。
 *
 * 为什么需要这个？
 * - StateField.update 只在 transaction 时触发，但语法树解析完成不产生 transaction。
 * - 初次创建编辑器时，语法树可能未完整解析，FencedCode/Table/Link 等节点未被识别，
 *   导致 widget 不渲染。语法树解析完成后，需要触发重算。
 * - 此 ViewPlugin 不提供任何装饰（decorations 不返回），仅用于副作用 dispatch。
 */
const wysiwygSyntaxWatcher = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      // 初次构造时强制解析语法树（小文档同步完成）
      ensureSyntaxTree(view.state, view.state.doc.length + 1, 5000);
    }
    update(u: ViewUpdate): void {
      // 语法树引用变化 = 异步解析完成（或文档变化触发重新解析）
      if (syntaxTree(u.startState) !== syntaxTree(u.state)) {
        u.view.dispatch({ effects: recomputeWysiwygEffect.of() });
      }
    }
    destroy(): void {
      // nothing to clean up
    }
  }
);

/** WYSIWYG 所需样式（标记隐藏/dim、bullet、分隔线、引用块左边框、T7.2 块级 widget）。 */
export const wysiwygTheme = EditorView.theme({
  ".murasaki-wysiwyg-mark-hide": {
    display: "none",
  },
  ".murasaki-wysiwyg-mark-dim": {
    opacity: "0.4",
    fontSize: "80%",
  },
  // 引用块：紫色淡背景 + 斜体 + 灰色文字，对齐预览 .markdown-body blockquote（T6）
  ".murasaki-wysiwyg-blockquote": {
    borderLeft: "3px solid var(--murasaki-purple-300, #d8b4fe)",
    background: "var(--murasaki-purple-50, #faf5ff)",
    color: "var(--murasaki-muted-foreground, #737373)",
    fontStyle: "italic",
    padding: "10px 16px",
    borderRadius:
      "0 var(--murasaki-radius-sm, 4px) var(--murasaki-radius-sm, 4px) 0",
  },
  ".murasaki-wysiwyg-bullet": {
    color: "var(--murasaki-primary, #9333ea)",
    paddingRight: "6px",
    userSelect: "none",
  },
  ".murasaki-wysiwyg-hr": {
    display: "block",
    borderBottom: "2px solid var(--murasaki-line, #e5e5e5)",
    margin: "6px 0",
    height: "0",
  },
  // T7.2 块级 widget 样式
  // 代码块：深色 neutral-900 背景，对齐预览 .markdown-body pre（T6）
  ".murasaki-wysiwyg-codeblock": {
    backgroundColor: "#171717",
    color: "#e5e7eb",
    borderRadius: "var(--murasaki-radius-md, 8px)",
    padding: "14px 18px",
    fontFamily: "var(--murasaki-font-mono, ui-monospace, monospace)",
    fontSize: "13px",
    lineHeight: "1.6",
    overflow: "auto",
    margin: "12px 0 16px",
    boxShadow: "var(--murasaki-shadow-sm, 0 1px 2px rgba(15, 23, 42, 0.04))",
  },
  // 代码块 wrapper + 语言标签栏（issue #85 / T2）：与预览 .code-block-wrapper 视觉一致
  ".murasaki-wysiwyg-codeblock-wrapper": {
    overflow: "hidden",
    borderRadius: "var(--murasaki-radius-md, 8px)",
    margin: "12px 0 16px",
    boxShadow: "var(--murasaki-shadow-sm, 0 1px 2px rgba(15, 23, 42, 0.04))",
  },
  ".murasaki-wysiwyg-codeblock-wrapper .murasaki-wysiwyg-codeblock": {
    margin: "0",
    borderRadius: "0",
    boxShadow: "none",
  },
  ".murasaki-wysiwyg-codeblock-wrapper .murasaki-wysiwyg-code-lang-label": {
    backgroundColor: "var(--murasaki-neutral-800, #262626)",
    color: "var(--murasaki-neutral-400, #a3a3a3)",
    fontSize: "11px",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    padding: "4px 12px",
    borderBottom: "1px solid var(--murasaki-neutral-700, #404040)",
  },
  // Mermaid：白色卡片包裹，对齐预览/T5（T6）
  ".murasaki-wysiwyg-mermaid": {
    background: "white",
    border: "1px solid var(--murasaki-border, #e5e5e5)",
    borderRadius: "var(--murasaki-radius-md, 8px)",
    padding: "0.75rem",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: "12px 0",
    minHeight: "20px",
    color: "var(--murasaki-ink-3, #a3a3a3)",
    fontSize: "12px",
  },
  ".murasaki-wysiwyg-mermaid svg": {
    maxWidth: "100%",
    height: "auto",
  },
  // 链接：紫色 primary + 始终下划线，对齐预览 .markdown-body a（T6）
  ".murasaki-wysiwyg-link": {
    color: "var(--murasaki-primary, #9333ea)",
    textDecoration: "underline",
    cursor: "text",
  },
  ".murasaki-wysiwyg-link:hover": {
    color: "var(--murasaki-purple-700, #7e22ce)",
  },
  // 图片：圆角 + 阴影，对齐预览 .markdown-body img（T6）
  ".murasaki-wysiwyg-image": {
    maxWidth: "100%",
    borderRadius: "var(--murasaki-radius-sm, 4px)",
    boxShadow: "var(--murasaki-shadow-sm, 0 1px 2px rgba(15, 23, 42, 0.04))",
    display: "inline-block",
    verticalAlign: "middle",
  },
  // 表格：字号 13px + padding 对齐预览 .markdown-body table（T6）
  ".murasaki-wysiwyg-table": {
    margin: "8px 0",
    overflow: "auto",
    fontSize: "13px",
  },
  ".murasaki-wysiwyg-table table": {
    borderCollapse: "collapse",
    width: "100%",
  },
  ".murasaki-wysiwyg-table th, .murasaki-wysiwyg-table td": {
    border: "1px solid var(--murasaki-line, #e5e5e5)",
    padding: "8px 14px",
  },
  ".murasaki-wysiwyg-table th": {
    backgroundColor: "var(--murasaki-surface-2, #f3f4f6)",
    fontWeight: "600",
  },
  // 数学公式：蓝色斜体，对齐预览 KaTeX 样式（T5 / T6）
  ".murasaki-wysiwyg-math": {
    color: "var(--murasaki-state-info, #2563eb)",
    fontStyle: "italic",
    display: "inline-block",
  },
  ".murasaki-wysiwyg-math-block": {
    display: "block",
    textAlign: "center",
    padding: "0.5rem 0",
  },
});

/**
 * 一键启用 WYSIWYG：StateField（提供装饰）+ 语法树监视 ViewPlugin + 主题。
 *
 * 在 SourceEditor.vue 中通过 Compartment 按模式（source/split/wysiwyg）叠加/移除。
 * - wysiwygField：StateField，提供所有 WYSIWYG 装饰（含跨换行块级 widget）
 * - wysiwygSyntaxWatcher：ViewPlugin，监听语法树异步解析并触发重算（不提供装饰）
 * - wysiwygTheme：EditorView.theme，WYSIWYG 样式
 */
export const wysiwygExtensions = [wysiwygField, wysiwygSyntaxWatcher, wysiwygTheme];