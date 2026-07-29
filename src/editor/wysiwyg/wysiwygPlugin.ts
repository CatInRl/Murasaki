/**
 * WYSIWYG ViewPlugin（Ticket #72 / T7.1, #76 / T7.2）。
 *
 * CodeMirror 6 ViewPlugin：遍历 @codemirror/lang-markdown 语法树，对行级语法标记
 * 应用 hide/dim decoration（光标在当前段 → dim；离开 → hide / 替换为 widget）。
 *
 * T7.1：行级标记 hide/dim + 列表 bullet / 分隔线 hr widget + 引用块左边框。
 * T7.2：块级 widget —— 代码块 Shiki 高亮 / 链接锚文本 / 图片 / 表格 / 数学 KaTeX / Mermaid SVG。
 *
 * Decoration 计算逻辑提取为纯函数 computeDecorations（便于单元测试），本文件负责：
 * - 把描述符转换为 CodeMirror DecorationSet
 * - 监听 selection / doc / viewport 变化（防抖 50ms）
 * - 大文档（>10000 行）仅计算可见视口
 * - Agent 提案覆盖范围不隐藏标记（提案优先级高于 WYSIWYG 隐藏）
 *
 * 详见 ADR-0008（CodeMirror 6 内 WYSIWYG / Typora 路线）。
 */
import { EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet, WidgetType } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { codeToHtml } from "shiki";
import katex from "katex";
import mermaid from "mermaid";
import { proposalField } from "../../agent/proposals";
import { currentShikiTheme, getMarkdownRenderer } from "../../composables/useMarkdownRenderer";
import {
  computeDecorations,
  ComputedDeco,
  BlockWidgetDeco,
  DEBOUNCE_MS,
  LARGE_DOC_LINE_THRESHOLD,
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

/** Mermaid 渲染 id 计数器（保证 SVG id 唯一）。 */
let mermaidIdCounter = 0;

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
    const pre = document.createElement("pre");
    pre.className = "murasaki-wysiwyg-codeblock";
    const codeEl = document.createElement("code");
    if (this.lang) codeEl.className = `language-${this.lang}`;
    codeEl.textContent = this.code;
    pre.appendChild(codeEl);
    // 异步 Shiki 高亮：完成后用高亮 HTML 替换占位
    void codeToHtml(this.code, { lang: this.lang || "text", theme: currentShikiTheme.value })
      .then((html) => {
        if (!pre.isConnected) return;
        const wrapper = document.createElement("div");
        wrapper.innerHTML = html;
        const replacement = wrapper.firstElementChild as HTMLElement | null;
        if (replacement) pre.replaceWith(replacement);
      })
      .catch(() => {
        // 未知语言或加载失败：保留 <pre><code> 占位
      });
    return pre;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Mermaid widget：替换 ```mermaid 代码块，用 mermaid.js 异步渲染 SVG。
 * toDOM 先返回带源码占位的容器，render 完成后注入 SVG。
 */
class MermaidWidget extends WidgetType {
  constructor(private code: string) {
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
    const id = `murasaki-mermaid-${mermaidIdCounter++}`;
    void mermaid
      .render(id, this.code)
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
    el.className = "murasaki-wysiwyg-math";
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
function createBlockWidget(d: BlockWidgetDeco): WidgetType {
  switch (d.widget) {
    case "codeBlock":
      return new CodeBlockWidget(d.lang, d.code);
    case "mermaid":
      return new MermaidWidget(d.code);
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

function toDecorationSet(decos: ComputedDeco[]): DecorationSet {
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
    return Decoration.replace({ widget: createBlockWidget(d) }).range(d.from, d.to);
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

// ===== ViewPlugin =====

class WysiwygPluginValue {
  decorations: DecorationSet;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(view: EditorView) {
    this.decorations = this.compute(view);
  }

  private compute(view: EditorView): DecorationSet {
    const state = view.state;
    const decos = computeDecorations({
      doc: state.doc.toString(),
      selectionHead: state.selection.main.head,
      tree: syntaxTree(state),
      proposalRanges: getProposalRanges(state),
      viewport:
        state.doc.lines > LARGE_DOC_LINE_THRESHOLD
          ? { from: view.viewport.from, to: view.viewport.to }
          : undefined,
    });
    return toDecorationSet(decos);
  }

  update(u: ViewUpdate): void {
    if (!u.docChanged && !u.selectionSet && !u.viewportChanged) return;
    // 防抖 50ms：合并连续光标移动 / 输入，避免每次按键都重算语法树遍历。
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.destroyed) return;
      this.decorations = this.compute(u.view);
      // 空事务触发 CM6 重新读取 decorations getter（getter 返回新的 DecorationSet）。
      u.view.dispatch([]);
    }, DEBOUNCE_MS);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) clearTimeout(this.timer);
  }
}

/** WYSIWYG ViewPlugin —— 叠加到现有 CodeMirror 编辑器即可启用 WYSIWYG 隐藏。 */
export const wysiwygPlugin = ViewPlugin.fromClass(WysiwygPluginValue, {
  decorations: (v) => v.decorations,
});

/** WYSIWYG 所需样式（标记隐藏/dim、bullet、分隔线、引用块左边框、T7.2 块级 widget）。 */
export const wysiwygTheme = EditorView.theme({
  ".murasaki-wysiwyg-mark-hide": {
    display: "none",
  },
  ".murasaki-wysiwyg-mark-dim": {
    opacity: "0.4",
    fontSize: "80%",
  },
  ".murasaki-wysiwyg-blockquote": {
    borderLeft: "3px solid var(--murasaki-purple-300, #d8b4fe)",
    paddingLeft: "10px",
    color: "var(--murasaki-ink-2, #525252)",
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
  ".murasaki-wysiwyg-codeblock": {
    backgroundColor: "var(--murasaki-surface, #fafafa)",
    border: "1px solid var(--murasaki-line, #e5e5e5)",
    borderRadius: "6px",
    padding: "8px 12px",
    fontFamily: "var(--murasaki-font-mono, ui-monospace, monospace)",
    fontSize: "12.5px",
    overflow: "auto",
    margin: "4px 0",
  },
  ".murasaki-wysiwyg-mermaid": {
    textAlign: "center",
    margin: "8px 0",
    minHeight: "20px",
    color: "var(--murasaki-ink-3, #a3a3a3)",
    fontSize: "12px",
  },
  ".murasaki-wysiwyg-mermaid svg": {
    maxWidth: "100%",
    height: "auto",
  },
  ".murasaki-wysiwyg-link": {
    color: "#2563eb",
    textDecoration: "underline",
    cursor: "text",
  },
  ".murasaki-wysiwyg-image": {
    maxWidth: "100%",
    display: "inline-block",
    verticalAlign: "middle",
  },
  ".murasaki-wysiwyg-table": {
    margin: "8px 0",
    overflow: "auto",
  },
  ".murasaki-wysiwyg-table table": {
    borderCollapse: "collapse",
    width: "100%",
  },
  ".murasaki-wysiwyg-table th, .murasaki-wysiwyg-table td": {
    border: "1px solid var(--murasaki-line, #e5e5e5)",
    padding: "4px 8px",
  },
  ".murasaki-wysiwyg-table th": {
    backgroundColor: "var(--murasaki-surface, #fafafa)",
    fontWeight: "600",
  },
  ".murasaki-wysiwyg-math": {
    display: "inline-block",
  },
});

/**
 * 一键启用 WYSIWYG：ViewPlugin + 主题。
 * 在 SourceEditor.vue 中通过 Compartment 按模式（source/split/wysiwyg）叠加/移除。
 */
export const wysiwygExtensions = [wysiwygPlugin, wysiwygTheme];