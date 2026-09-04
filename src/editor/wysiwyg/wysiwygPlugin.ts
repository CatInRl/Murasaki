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
import { currentShikiTheme, resolveShikiThemeOption, getCurrentFilePath } from "../../composables/useMarkdownRenderer";
import {
  computeDecorations,
  getParagraphRange,
  ComputedDeco,
  BlockWidgetDeco,
} from "./computeDecorations";
import { findEmojiShortcodesInRange } from "./emojiReplacement";
import { sanitizeInlineHtml } from "./htmlSanitizer";
import { parseTable } from "./tableReflow";
import { TableEditor } from "./tableEditor";
import { renderFrontMatterCard } from "../../composables/useFrontMatter";
import { resolveImageSrc } from "../../utils/imagePath";
import { renderPlantUmlCode } from "../../utils/plantuml";

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

/** 判断 widget 范围是否与当前选区相交（用于选中高亮）。 */
function selectionIntersects(
  from: number,
  to: number,
  selection: { from: number; to: number } | null
): boolean {
  if (!selection) return false;
  return from < selection.to && to > selection.from;
}

/**
 * 块级 widget 基类：叠加选区高亮 class。
 * - selected：本 widget 是否被当前选区覆盖（Ctrl+A 全选时所有块级区域标记选中）。
 * - 选区变化触发 wysiwygField 重算 → 重建 widget → toDOM 重渲染时带上高亮。
 * 子类约束：构造器把 selected 传给 super；eq 需合并 this.sameSelection(other)；
 * 根元素 class 需追加 this.selectionClass()。
 */
abstract class WysiwygBlockWidget extends WidgetType {
  protected readonly selected: boolean;

  protected constructor(selected: boolean) {
    super();
    this.selected = selected;
  }

  protected sameSelection(other: WidgetType): boolean {
    return other instanceof WysiwygBlockWidget && other.selected === this.selected;
  }

  protected selectionClass(): string {
    return this.selected ? " murasaki-wysiwyg-selected" : "";
  }
}

/**
 * 代码块 widget：替换整个 FencedCode，用 Shiki 异步高亮渲染。
 * toDOM 先返回 <pre><code> 占位，codeToHtml 完成后替换为高亮 HTML。
 * 占位阶段保持代码可读，避免视觉跳变。
 */
class CodeBlockWidget extends WysiwygBlockWidget {
  constructor(private lang: string, private code: string, private from: number, selected: boolean) {
    super(selected);
  }
  eq(other: CodeBlockWidget): boolean {
    return other.lang === this.lang && other.code === this.code && this.sameSelection(other);
  }
  toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = `murasaki-wysiwyg-codeblock-wrapper code-block-wrapper${this.selectionClass()}`;

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
class MermaidWidget extends WysiwygBlockWidget {
  constructor(private code: string, private id: string, private from: number, selected: boolean) {
    super(selected);
  }
  eq(other: MermaidWidget): boolean {
    return other.code === this.code && this.sameSelection(other);
  }
  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.className = `murasaki-wysiwyg-mermaid mermaid${this.selectionClass()}`;
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
 * 实时预览卡 widget（问题2）：光标进入 mermaid/plantuml/katex 围栏代码块时，
 * 渲染在其代码块下方的实时预览卡。替换的是代码块结尾的换行符（见 computeDecorations）。
 * 源码仍保持可编辑（围栏 CodeMark dim），预览随键入实时更新。
 */
class DiagramPreviewWidget extends WysiwygBlockWidget {
  constructor(private lang: string, private code: string, selected: boolean) {
    super(selected);
  }
  eq(other: DiagramPreviewWidget): boolean {
    return other.lang === this.lang && other.code === this.code && this.sameSelection(other);
  }
  toDOM(): HTMLElement {
    const card = document.createElement("div");
    card.className = `murasaki-wysiwyg-diagram-preview${this.selectionClass()}`;

    const head = document.createElement("div");
    head.className = "murasaki-wysiwyg-diagram-preview-head";
    head.textContent = `${this.lang} 预览`;
    card.appendChild(head);

    const body = document.createElement("div");
    body.className = "murasaki-wysiwyg-diagram-preview-body";
    card.appendChild(body);

    const lang = this.lang.trim().toLowerCase();
    if (lang === "mermaid") {
      const id = `murasaki-preview-mermaid-${Math.random().toString(36).slice(2, 10)}`;
      body.classList.add("mermaid");
      body.textContent = this.code; // 占位：出错时保留源码便于排错
      void mermaid
        .render(id, this.code)
        .then(({ svg }) => {
          if (body.isConnected) body.innerHTML = svg;
        })
        .catch(() => {
          // 渲染失败：保留源码占位
        });
    } else if (lang === "katex" || lang === "math") {
      body.classList.add("katex", "katex-display");
      try {
        body.innerHTML = katex.renderToString(this.code, {
          displayMode: true,
          throwOnError: false,
          strict: false,
        });
      } catch {
        body.textContent = this.code;
      }
    } else if (lang === "plantuml") {
      body.textContent = this.code; // 占位
      void renderPlantUmlCode(this.code, body, "murasaki-preview-plantuml");
    }
    return card;
  }
  // 预览卡不可交互，事件全部交给 CM（避免点击时移动光标）
  ignoreEvent(): boolean {
    return true;
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
class LinkWidget extends WysiwygBlockWidget {
  constructor(private text: string, private url: string, selected: boolean) {
    super(selected);
  }
  eq(other: LinkWidget): boolean {
    return other.text === this.text && other.url === this.url && this.sameSelection(other);
  }
  toDOM(): HTMLElement {
    const a = document.createElement("a");
    a.className = `murasaki-wysiwyg-link${this.selectionClass()}`;
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
class ImageWidget extends WysiwygBlockWidget {
  /** 构造时解析好的 src（基于当前文件路径）。eq 比较此值，路径变化时触发重渲染。 */
  private resolvedSrc: string;

  constructor(private alt: string, url: string, selected: boolean) {
    super(selected);
    // ADR-0015：在构造时解析 src（而非 toDOM 时），这样 eq 比较解析后的值，
    // 当 currentFilePath 变化时（切 tab），新 widget 的 resolvedSrc 不同，
    // eq 返回 false，CM6 会调用 toDOM 重新渲染图片。
    this.resolvedSrc = resolveImageSrc(url, getCurrentFilePath());
  }
  eq(other: ImageWidget): boolean {
    return other.alt === this.alt && other.resolvedSrc === this.resolvedSrc && this.sameSelection(other);
  }
  toDOM(): HTMLElement {
    const img = document.createElement("img");
    img.className = `murasaki-wysiwyg-image${this.selectionClass()}`;
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
 * 表格 widget：替换 Table 节点，就地编辑（T1.2）。
 *
 * 用 T1.1 纯函数核心 parseTable 把 markdown 管道符解析为内存单元格模型，
 * 渲染为可编辑（contenteditable）的 <table>。点击/聚焦单元格设为锚点并高亮，
 * 其它单元格悬停显示可编辑提示；光标离开表格块（widget 重建）回到只读渲染态。
 * 单元格内容以纯文本（转义）呈现，便于直接编辑；真正的写回由 T1.5 处理。
 */
class TableWidget extends WysiwygBlockWidget {
  constructor(private source: string, private from: number, selected: boolean) {
    super(selected);
  }
  eq(other: TableWidget): boolean {
    return other.source === this.source && this.sameSelection(other);
  }
  toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = `murasaki-wysiwyg-table murasaki-wysiwyg-table-edit${this.selectionClass()}`;

    const model = parseTable(this.source);
    if (!model) {
      // 非法表格：降级显示原始 markdown 源码
      wrapper.textContent = this.source;
      return wrapper;
    }

    // T1.2-T1.6：就地表格编辑器（contentEditable 单元格 + 锚点 + 结构化操作）
    const to = this.from + this.source.length;
    const editor = new TableEditor(this.source, {
      // 提交（写回）：替换 [from, to] 的原始表格源码为规范化后的新源码，
      // 由 SourceEditor dispatch 进入 CM 文档（因此可撤销，T1.6）。
      // 携带锚点坐标：提交后表格块重建，宿主据此把焦点/光标放回同一单元格（留在表格内）。
      onCommit: (nextSource, anchorCell) => {
        wrapper.dispatchEvent(new CustomEvent("murasaki-table-commit", {
          bubbles: true,
          detail: { from: this.from, to, source: nextSource, anchorCell: anchorCell ?? null },
        }));
      },
    });

    const table = editor.render(wrapper);
    wrapper.appendChild(table);
    wrapper.dataset.from = String(this.from);
    this.attachToolbar(wrapper, editor);
    return wrapper;
  }

  /** 悬停工具条 + 行列增删 + 对齐（T1.4，与 murasaki-ui-design/pages/ux-wysiwyg-table.html 保持一致）。 */
  private attachToolbar(wrapper: HTMLElement, editor: TableEditor): void {
    const doc = wrapper.ownerDocument;
    const toolbar = doc.createElement("div");
    toolbar.className = "murasaki-wysiwyg-table-toolbar";
    toolbar.contentEditable = "false";

    // 分隔条（设计稿；按钮分组间用细竖线隔开）
    const divider = (): HTMLSpanElement => {
      const d = doc.createElement("span");
      d.className = "murasaki-wysiwyg-table-tool-divider";
      d.setAttribute("aria-hidden", "true");
      return d;
    };

    // 工具按钮：innerHTML 由调用方提供（图标/图标+文字），样式类统一给 .murasaki-wysiwyg-table-tool
    const mkBtn = (inner: string, title: string, onClick: () => void, opts: { active?: boolean; data?: string } = {}) => {
      const b = doc.createElement("button");
      b.type = "button";
      b.title = title;
      b.className = "murasaki-wysiwyg-table-tool" + (opts.active ? " active" : "");
      if (opts.data !== undefined) b.dataset.align = opts.data;
      b.innerHTML = inner;
      b.addEventListener("mousedown", (e) => e.preventDefault()); // 防止点击移走单元格焦点
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      });
      return b;
    };

    const ic = (d: string): string =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true">${d}</svg>`;

    // 上部：表格标签 + 上一列/下一列（拖移锚点横向移动）
    const label = doc.createElement("span");
    label.className = "murasaki-wysiwyg-table-tool-label";
    label.textContent = "表格";
    const prevColBtn = mkBtn(ic("<path d=\"m15 18-6-6 6-6\"/>"), "上一列", () => editor.navigateColumn(-1));
    const nextColBtn = mkBtn(ic("<path d=\"m9 18 6-6-6-6\"/>"), "下一列", () => editor.navigateColumn(1));

    // 中部：插入行/插入列
    const rowsIcon = ic("<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"/><path d=\"M21 9H3\"/><path d=\"M21 15H3\"/>");
    const colsIcon = ic("<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"/><path d=\"M9 3v18\"/><path d=\"M15 3v18\"/>");
    const addRowBtn = mkBtn(`${rowsIcon}<span>行</span>`, "插入行", () => editor.addRowAfterAnchor());
    const addColBtn = mkBtn(`${colsIcon}<span>列</span>`, "插入列", () => editor.addColumnAfterAnchor());

    // 删除行/删除列（删除列旋转 90° 与设计稿一致）
    const trashIcon = ic("<path d=\"M3 6h18\"/><path d=\"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6\"/><path d=\"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2\"/><line x1=\"10\" x2=\"10\" y1=\"11\" y2=\"17\"/><line x1=\"14\" x2=\"14\" y1=\"11\" y2=\"17\"/>");
    const delRowBtn = mkBtn(trashIcon, "删除行", () => editor.removeRowAtAnchor());
    const delColBtn = mkBtn(trashIcon, "删除列", () => editor.removeColumnAtAnchor());
    delColBtn.classList.add("murasaki-wysiwyg-table-tool-rotate");

    // 对齐：左/中/右，激活态随锚点列对齐刷新
    const alignL = mkBtn(ic("<path d=\"M21 6H3\"/><path d=\"M15 12H3\"/><path d=\"M17 18H3\"/>"), "左对齐", () => editor.setAnchorAlignment("l"), { data: "l" });
    const alignC = mkBtn(ic("<path d=\"M21 6H3\"/><path d=\"M17 12H7\"/><path d=\"M16 18H8\"/>"), "居中对齐", () => editor.setAnchorAlignment("c"), { data: "c" });
    const alignR = mkBtn(ic("<path d=\"M21 6H3\"/><path d=\"M21 12H9\"/><path d=\"M21 18H7\"/>"), "右对齐", () => editor.setAnchorAlignment("r"), { data: "r" });
    const alignBtns = [alignL, alignC, alignR];

    // 锚点变化 → 刷新边界按钮置灰 + 对齐激活态 + 编辑态样式（无锚点时隐藏工具条）
    const syncActive = () => {
      delColBtn.disabled = !editor.canDeleteColumn();
      delRowBtn.disabled = !editor.canDeleteRow();
      const align = editor.activeAlignment;
      alignBtns.forEach((b) => b.classList.toggle("active", b.dataset.align === align));
      wrapper.classList.toggle("murasaki-wysiwyg-table-edit-active", editor.activeAnchor != null);
    };
    editor.onAnchorChange = syncActive;
    syncActive();

    toolbar.append(
      label,
      divider(),
      prevColBtn,
      nextColBtn,
      divider(),
      addRowBtn,
      addColBtn,
      divider(),
      delRowBtn,
      delColBtn,
      divider(),
      alignL,
      alignC,
      alignR,
    );
    wrapper.appendChild(toolbar);
  }
  // 表格内所有键盘/DOM 编辑事件由浏览器 contentEditable 处理，不交还 CM
  // （click 也由单元格 focus 接管，不再跳到块首）。
  // Ctrl/Cmd+Z / Y 必须交还浏览器原生撤销/重做：表格内文本改动发生在 contentEditable DOM，
  // 并未写入 CM 文档；若把撤销交给 CM，会用「上一次整表写回/无关事务」去撤销，导致
  // 表格内按 Ctrl+Z 无法正常撤销刚输入的内容。
  // 仅把 Ctrl/Cmd+A（全选）与 Ctrl/Cmd+S（保存）这类全局命令交还 CM。
  ignoreEvent(event: Event): boolean {
    if (
      event instanceof KeyboardEvent &&
      (event.ctrlKey || event.metaKey) &&
      (event.key === "a" || event.key === "s")
    ) {
      return false;
    }
    return true;
  }
}

/**
 * 数学公式 widget：替换 $...$ / $$...$$，用 KaTeX 同步渲染。
 * displayMode=true → 块级 <div>；false → 行内 <span>。
 */
class MathWidget extends WysiwygBlockWidget {
  constructor(private expr: string, private displayMode: boolean, private from: number, selected: boolean) {
    super(selected);
  }
  eq(other: MathWidget): boolean {
    return other.expr === this.expr && other.displayMode === this.displayMode && this.sameSelection(other);
  }
  toDOM(): HTMLElement {
    const el = document.createElement(this.displayMode ? "div" : "span");
    // 块级公式追加 modifier class，便于在 wysiwygTheme 中区分块级居中样式（T6）
    el.className = this.displayMode
      ? `murasaki-wysiwyg-math murasaki-wysiwyg-math-block katex katex-display${this.selectionClass()}`
      : `murasaki-wysiwyg-math katex${this.selectionClass()}`;
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
class EmojiWidget extends WysiwygBlockWidget {
  constructor(private emoji: string, private shortcode: string, selected: boolean) {
    super(selected);
  }
  eq(other: EmojiWidget): boolean {
    return other.shortcode === this.shortcode && this.sameSelection(other);
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = `murasaki-wysiwyg-emoji${this.selectionClass()}`;
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
class FrontmatterCardWidget extends WysiwygBlockWidget {
  constructor(private content: string, private from: number, selected: boolean) {
    super(selected);
  }
  eq(other: FrontmatterCardWidget): boolean {
    return other.content === this.content && this.sameSelection(other);
  }
  toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    // markdown-body class on editor container makes .front-matter-card selectors match
    wrapper.className = `murasaki-wysiwyg-frontmatter${this.selectionClass()}`;
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
class HtmlWidget extends WysiwygBlockWidget {
  constructor(private source: string, private from: number, selected: boolean) {
    super(selected);
  }
  eq(other: HtmlWidget): boolean {
    return other.source === this.source && this.sameSelection(other);
  }
  toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = `murasaki-wysiwyg-html${this.selectionClass()}`;
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
function createBlockWidget(
  d: BlockWidgetDeco,
  nextMermaidId: () => string,
  selected: boolean
): WidgetType {
  switch (d.widget) {
    case "codeBlock":
      return new CodeBlockWidget(d.lang, d.code, d.from, selected);
    case "mermaid":
      return new MermaidWidget(d.code, nextMermaidId(), d.from, selected);
    case "diagramPreview":
      return new DiagramPreviewWidget(d.lang, d.code, selected);
    case "link":
      return new LinkWidget(d.text, d.url, selected);
    case "image":
      return new ImageWidget(d.alt, d.url, selected);
    case "table":
      return new TableWidget(d.source, d.from, selected);
    case "math":
      return new MathWidget(d.expr, d.displayMode, d.from, selected);
    case "emoji":
      return new EmojiWidget(d.emoji, d.shortcode, selected);
    case "frontmatter":
      return new FrontmatterCardWidget(d.content, d.from, selected);
    case "html":
      return new HtmlWidget(d.source, d.from, selected);
  }
}

// ===== 描述符 → CodeMirror Decoration =====

function toDecorationSet(
  decos: ComputedDeco[],
  nextMermaidId: () => string,
  selection: { from: number; to: number } | null
): DecorationSet {
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
    // blockWidget：用渲染 widget 替换原始 markdown；选区覆盖时叠加选中高亮
    const selected = selectionIntersects(d.from, d.to, selection);
    return Decoration.replace({ widget: createBlockWidget(d, nextMermaidId, selected) }).range(d.from, d.to);
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
  // 选区范围（锚点↔头）。空选区（光标）→ null，不叠加选中高亮。
  const sel = state.selection.main;
  const selection = sel.empty
    ? null
    : {
        from: Math.min(sel.anchor, sel.head),
        to: Math.max(sel.anchor, sel.head),
      };
  const decos = computeDecorations({
    doc: state.doc.toString(),
    selectionHead: state.selection.main.head,
    tree: syntaxTree(state),
    proposalRanges: getProposalRanges(state),
    // StateField 不访问 viewport —— 全量计算（大文档性能可接受）
    viewport: undefined,
  });
  return toDecorationSet(decos, nextMermaidId, selection);
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
  // 块级 widget 的选区高亮（Ctrl+A 全选时叠加选中底色/描边）：
  // WYSIWYG 下块级元素被替换为渲染 widget，原生选区不会覆盖其上，
  // 用 CSS 类模拟选中态，保证「全选」在视觉上也成立。
  ".murasaki-wysiwyg-selected": {
    backgroundColor: "var(--md-code-selection, rgba(147, 51, 234, 0.08))",
    outline: "1px solid var(--md-code-selection-outline, rgba(147, 51, 234, 0.30))",
    borderRadius: "4px",
  },
  // 行内代码：与预览 .markdown-body code 一致的视觉样式（背景/圆角/等宽字体）。
  // 覆盖整段（含反引号）；内层高亮 token span 会被后代选择器重置，
  // 避免高亮样式（固定紫色背景/紫 800 文字）盖住 --md-code-* 主题变量。
  ".murasaki-wysiwyg-inline-code": {
    fontFamily: "var(--murasaki-font-mono)",
    fontSize: "13px",
    background: "var(--md-code-bg, var(--murasaki-surface-2))",
    color: "var(--md-code-color, var(--murasaki-primary))",
    padding: "0.125rem 0.375rem",
    borderRadius: "var(--murasaki-radius-sm, 4px)",
  },
  // 中性化 CM 高亮 token span（class 以 ͼ 前缀开头）对 render 装饰内部文本的干扰：
  // 标题/引用/行内代码的视觉由 --md-* 变量统一提供，否则高亮样式（紫色、em 字号）
  // 会盖住 render 装饰，导致 WYSIWYG 与预览不一致（与行内代码同一根因）。
  ".murasaki-wysiwyg-inline-code [class^=\"ͼ\"]": {
    background: "transparent",
    color: "inherit",
  },
  ".murasaki-wysiwyg-h1 [class^=\"ͼ\"], .murasaki-wysiwyg-h2 [class^=\"ͼ\"], .murasaki-wysiwyg-h3 [class^=\"ͼ\"], .murasaki-wysiwyg-h4 [class^=\"ͼ\"], .murasaki-wysiwyg-h5 [class^=\"ͼ\"], .murasaki-wysiwyg-h6 [class^=\"ͼ\"]": {
    color: "inherit",
    fontSize: "inherit",
    fontWeight: "inherit",
  },
  ".murasaki-wysiwyg-blockquote [class^=\"ͼ\"]": {
    color: "inherit",
  },
  // 引用块：CM6 mark decoration 样式（无法用 <blockquote> 标签，需独立样式）
  // 引用 --md-* 变量与 markdown-content.css 保持视觉一致
  // 注意：mark decoration 是行内 span，垂直 padding 不会撑开行盒（多行引用会挤压/重叠），
  // 因此只保留水平 padding，用 lineHeight 提供上下间距，保证引用内容完整展示。
  ".murasaki-wysiwyg-blockquote": {
    borderLeft: "3px solid var(--md-quote-border, var(--murasaki-purple-300, #d8b4fe))",
    background: "var(--md-quote-bg, var(--murasaki-purple-50, #faf5ff))",
    color: "var(--md-quote-color, var(--murasaki-muted-foreground, #737373))",
    fontStyle: "var(--md-quote-style, italic)",
    paddingLeft: "16px",
    paddingRight: "16px",
    lineHeight: "1.8",
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
  // 问题1：重置 CM6 .cm-content 的 white-space:pre-wrap 继承。
  // pre-wrap 会保留 thead/tbody 之间的空白文本节点，把它们拆成两个匿名 table 框，
  // 导致表头与表体列宽各自计算而错位；恢复 normal 可保证表头/表体逐列对齐。
  ".murasaki-wysiwyg-table": {
    whiteSpace: "normal",
  },
  // T1.2 就地编辑：表格网格 + 单元格悬停/可编辑提示 + 锚点格高亮
  ".murasaki-wysiwyg-table-edit": {
    cursor: "text",
    // 悬停胶囊（右缘/底缘 ＋）以绝对定位相对表格块定位
    position: "relative",
    // 块宽度收拢到表格宽度，使正上方的悬浮工具条可相对表格水平居中
    width: "fit-content",
    maxWidth: "100%",
  },
  ".murasaki-wysiwyg-table-edit .murasaki-wysiwyg-table-grid": {
    borderCollapse: "collapse",
    width: "auto",
    margin: "8px 0",
  },
  ".murasaki-wysiwyg-table-edit th, .murasaki-wysiwyg-table-edit td": {
    border: "1px solid var(--md-table-border, var(--murasaki-line, rgba(0,0,0,0.12)))",
    padding: "4px 12px",
    minWidth: "48px",
    minHeight: "24px",
    outline: "none",
    backgroundColor: "transparent",
  },
  ".murasaki-wysiwyg-table-edit th": {
    background: "var(--md-table-th-bg, var(--murasaki-surface-2))",
    fontWeight: "600",
  },
  ".murasaki-wysiwyg-table-edit td:hover": {
    background: "var(--md-table-row-hover-bg, var(--murasaki-purple-50, #faf5ff))",
  },
  // 锚点格（当前聚焦）：绿色高亮，配合右缘/底缘 + 胶囊指示可插入位置
  ".murasaki-wysiwyg-table-edit .murasaki-anchor-cell": {
    boxShadow: "0 0 0 2px var(--murasaki-primary, #9333ea) inset",
    backgroundColor: "var(--md-table-row-hover-bg, var(--murasaki-purple-50, #faf5ff))",
  },
  // T1.4 悬停工具条：聚焦单元格时显示增删/对齐工具。
  // 默认隐藏、贴近表格左缘上方（absolute）；仅在编辑激活（有锚点格）时显示，
  // 避免常驻占位把下一行内容往下推。样式与 murasaki-ui-design/pages/ux-wysiwyg-table.html 一致。
  ".murasaki-wysiwyg-table-edit .murasaki-wysiwyg-table-toolbar": {
    display: "none",
    position: "absolute",
    top: "-44px",
    left: "0",
    gap: "3px",
    alignItems: "center",
    padding: "2px 6px",
    background: "var(--murasaki-card, var(--murasaki-surface, #ffffff))",
    border: "1px solid var(--murasaki-border, var(--murasaki-line, rgba(0,0,0,0.1)))",
    borderRadius: "var(--murasaki-radius-md, 8px)",
    boxShadow: "var(--murasaki-shadow-sm, 0 1px 3px rgba(0,0,0,0.10))",
    width: "max-content",
    maxWidth: "100%",
    flexWrap: "wrap",
    userSelect: "none",
    zIndex: 3,
  },
  ".murasaki-wysiwyg-table-edit-active .murasaki-wysiwyg-table-toolbar": {
    display: "flex",
  },
  ".murasaki-wysiwyg-table-tool-label": {
    fontSize: "11px",
    fontWeight: "600",
    color: "var(--murasaki-muted-foreground, var(--murasaki-ink-3, #a1a1aa))",
    padding: "0 2px",
  },
  ".murasaki-wysiwyg-table-tool-divider": {
    width: "1px",
    height: "16px",
    background: "var(--murasaki-border, var(--murasaki-line, rgba(0,0,0,0.1)))",
    margin: "0 2px",
  },
  ".murasaki-wysiwyg-table-tool": {
    display: "inline-flex",
    alignItems: "center",
    gap: "2px",
    fontSize: "11px",
    lineHeight: "1",
    padding: "3px 5px",
    border: "none",
    borderRadius: "var(--murasaki-radius-sm, 5px)",
    background: "transparent",
    color: "var(--murasaki-ink-2, #52525b)",
    cursor: "pointer",
    transition: "background 120ms, color 120ms",
  },
  ".murasaki-wysiwyg-table-tool:hover": {
    background: "var(--murasaki-muted, var(--murasaki-surface-2, #f3f4f6))",
    color: "var(--murasaki-primary, #9333ea)",
  },
  ".murasaki-wysiwyg-table-tool.active": {
    background: "var(--murasaki-purple-100, #f3e8ff)",
    color: "var(--murasaki-primary, #9333ea)",
  },
  ".murasaki-wysiwyg-table-tool:disabled": {
    opacity: 0.4,
    cursor: "not-allowed",
  },
  // 删除列：垂直方向垃圾桶 → 旋转 90°（与设计稿一致）
  ".murasaki-wysiwyg-table-tool-rotate svg": {
    transform: "rotate(90deg)",
  },
  // T1.4 悬停插入胶囊：默认透明，悬浮表格块时显示于右缘(＋列)/底缘(＋行)
  ".murasaki-table-edge-cap": {
    position: "absolute",
    width: "18px",
    height: "18px",
    boxSizing: "border-box",
    borderRadius: "50%",
    border: "1px solid var(--murasaki-primary, #9333ea)",
    background: "var(--murasaki-surface, #ffffff)",
    color: "var(--murasaki-primary, #9333ea)",
    fontSize: "13px",
    lineHeight: "16px",
    textAlign: "center",
    padding: 0,
    cursor: "pointer",
    opacity: 0,
    transition: "opacity 0.15s",
    zIndex: 2,
    userSelect: "none",
  },
  ".murasaki-wysiwyg-table-edit:hover .murasaki-table-edge-cap": {
    opacity: 1,
  },
  ".murasaki-table-edge-cap-right": {
    right: "-9px",
    top: "50%",
    transform: "translateY(-50%)",
  },
  ".murasaki-table-edge-cap-bottom": {
    left: "50%",
    bottom: "-9px",
    transform: "translateX(-50%)",
  },
  ".murasaki-table-edge-cap:hover": {
    background: "var(--murasaki-primary, #9333ea)",
    color: "#fff",
  },
  ".murasaki-wysiwyg-mermaid svg": {
    maxWidth: "100%",
    height: "auto",
  },
  // 实时预览卡（问题2）：代码块下方，边框 + 内边距，与代码块视觉区分
  ".murasaki-wysiwyg-diagram-preview": {
    margin: "4px 0 12px",
    border: "1px solid var(--md-pre-border, var(--murasaki-line, rgba(0,0,0,0.1)))",
    borderRadius: "var(--murasaki-radius-sm, 6px)",
    overflow: "hidden",
    background: "var(--murasaki-surface, var(--md-pre-bg, #fafafa))",
  },
  ".murasaki-wysiwyg-diagram-preview-head": {
    fontSize: "11px",
    fontWeight: "600",
    color: "var(--md-code-lang-color, var(--murasaki-ink-3, #a1a1aa))",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    padding: "4px 10px",
    borderBottom: "1px solid var(--md-pre-border, var(--murasaki-line, rgba(0,0,0,0.1)))",
    background: "var(--murasaki-surface-2, transparent)",
  },
  ".murasaki-wysiwyg-diagram-preview-body": {
    padding: "10px",
    maxWidth: "100%",
    overflowX: "auto",
  },
  ".murasaki-wysiwyg-diagram-preview-body svg": {
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