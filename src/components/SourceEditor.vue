<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { EditorState, Compartment, Transaction, Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, selectAll } from "@codemirror/commands";
import { indentOnInput, bracketMatching, foldGutter, foldKeymap, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { languageForFile } from "../editor/language";
import { isMarkdownFile } from "../utils/fileKind";
import { basename } from "../utils/path";
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from "@codemirror/search";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { tags } from "@lezer/highlight";
import {
  Scissors,
  Copy,
  ClipboardPaste,
  TextSelect,
  Search,
  Table,
  Link as LinkIcon,
  Image as ImageIcon,
  Clipboard,
} from "lucide-vue-next";
import { buildEditorShortcutExtension, useShortcuts } from "../shortcuts/useShortcuts";
import { formatShortcutForDisplay } from "../shortcuts/shortcutsLogic";
import { useEditorBridgeStore } from "../stores/useEditorBridgeStore";
import { useContextMenuStore } from "../stores/useContextMenuStore";
import type { MenuItem } from "../stores/useContextMenuStore";
import {
  proposalField,
  proposalActionEffect,
  addProposalEffect,
  removeProposalEffect,
  expireAllProposalsEffect,
} from "../agent/proposals";
import { useProposalsStore } from "../stores/useProposalsStore";
import { wysiwygExtensions, recomputeWysiwygEffect } from "../editor/wysiwyg/wysiwygPlugin";
import { setCurrentFilePath } from "../composables/useMarkdownRenderer";
import { fullwidthToMarkdownExtension } from "../editor/fullwidthToMarkdown";

/**
 * Murasaki syntax theme — purple-tinted, writing-first (ADR-0006).
 *
 * 所有颜色引用 --murasaki-* token（来自 src/styles/theme.css），
 * 不再硬编码 hex 值。语义 token（--murasaki-ink / ink-2 / ink-3 /
 * muted-foreground）会随浅色/深色主题自动切换；调色板 token
 * （--murasaki-purple-* / --murasaki-state-*）在两种模式下通用。
 *
 * HighlightStyle.define 与 EditorView.theme 一样通过 StyleModule 生成
 * CSS 规则，因此 var(--murasaki-*) 字符串在运行时解析为具体颜色值，
 * 主题切换时无需重建 HighlightStyle。
 */
const murasakiHighlightStyle = HighlightStyle.define([
  // Headings: purple-700, bold
  { tag: tags.heading1, color: "var(--murasaki-purple-700)", fontWeight: "700", fontSize: "1.25em" },
  { tag: tags.heading2, color: "var(--murasaki-purple-700)", fontWeight: "700", fontSize: "1.15em" },
  { tag: tags.heading3, color: "var(--murasaki-purple-600)", fontWeight: "600", fontSize: "1.05em" },
  { tag: [tags.heading4, tags.heading5, tags.heading6], color: "var(--murasaki-purple-600)", fontWeight: "600" },
  // ATX heading markers (#, ##): purple-400
  { tag: tags.heading, color: "var(--murasaki-purple-400)" },
  // Emphasis — 语义 token，随主题切换（颜色与预览 .markdown-body em/strong/del 一致）
  { tag: tags.strong, color: "var(--murasaki-ink)", fontWeight: "700" },
  { tag: tags.emphasis, color: "var(--murasaki-ink)", fontStyle: "italic" },
  { tag: tags.strikethrough, color: "var(--murasaki-muted-foreground)", textDecoration: "line-through" },
  // Links
  { tag: tags.link, color: "var(--murasaki-purple-700)", textDecoration: "underline" },
  { tag: tags.url, color: "var(--murasaki-state-info)" },
  // Inline code & code blocks
  { tag: tags.monospace, color: "var(--murasaki-purple-800)", backgroundColor: "rgba(147, 51, 234, 0.08)" },
  // Lists: purple marker
  { tag: tags.list, color: "var(--murasaki-purple-600)" },
  // Quotes: purple-600 italic
  { tag: tags.quote, color: "var(--murasaki-purple-600)", fontStyle: "italic" },
  // HR
  { tag: tags.separator, color: "var(--murasaki-neutral-300)" },
  // URLs in angle brackets
  { tag: tags.angleBracket, color: "var(--murasaki-ink-3)" },
  // YAML frontmatter
  { tag: tags.meta, color: "var(--murasaki-muted-foreground)" },
  // Code block keywords
  { tag: tags.keyword, color: "var(--murasaki-purple-700)", fontWeight: "600" },
  { tag: tags.atom, color: "var(--murasaki-state-info)" },
  { tag: tags.bool, color: "var(--murasaki-state-info)" },
  { tag: tags.number, color: "var(--murasaki-state-info)" },
  { tag: tags.string, color: "var(--murasaki-state-success)" },
  { tag: tags.escape, color: "var(--murasaki-state-warning)" },
  { tag: tags.comment, color: "var(--murasaki-ink-3)", fontStyle: "italic" },
  { tag: tags.tagName, color: "var(--murasaki-purple-700)" },
  { tag: tags.attributeName, color: "var(--murasaki-purple-600)" },
  { tag: tags.attributeValue, color: "var(--murasaki-state-success)" },
  { tag: tags.definitionOperator, color: "var(--murasaki-purple-700)" },
  { tag: tags.operator, color: "var(--murasaki-ink-2)" },
  { tag: tags.variableName, color: "var(--murasaki-ink)" },
  { tag: tags.propertyName, color: "var(--murasaki-purple-600)" },
  { tag: tags.typeName, color: "var(--murasaki-state-info)" },
  { tag: tags.className, color: "var(--murasaki-purple-700)" },
  { tag: tags.function(tags.variableName), color: "var(--murasaki-state-info)" },
  { tag: tags.labelName, color: "var(--murasaki-purple-600)" },
]);

const murasakiTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--murasaki-background)",
    color: "var(--murasaki-ink)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--murasaki-surface)",
    color: "var(--murasaki-ink-3)",
    borderRight: "1px solid var(--murasaki-line)",
    border: "none",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--murasaki-primary)",
    fontWeight: "500",
  },
  ".cm-content": {
    // 字体/字号/行高由 fontComp 动态应用（buildFontTheme），统一各编辑模式使用阅读字体
    padding: "12px 0",
    caretColor: "var(--murasaki-primary)",
  },
  ".cm-line": {
    padding: "0 16px",
  },
  ".cm-activeLine": {
    backgroundColor: "rgba(147, 51, 234, 0.05)",
    boxShadow: "inset 2px 0 0 var(--murasaki-primary)",
  },
  ".cm-selectionBackground, ::selection": {
    backgroundColor: "var(--murasaki-purple-200) !important",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--murasaki-primary)",
    borderLeftWidth: "2px",
  },
  ".cm-matchingBracket, .cm-nonmatchingBracket": {
    color: "inherit",
    backgroundColor: "rgba(147, 51, 234, 0.12)",
    outline: "1px solid var(--murasaki-purple-300)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--murasaki-purple-100)",
    border: "1px solid var(--murasaki-purple-200)",
    color: "var(--murasaki-primary)",
    borderRadius: "3px",
    fontSize: "11px",
    padding: "0 6px",
  },
  ".cm-foldGutter .cm-gutterElement": {
    cursor: "pointer",
    color: "var(--murasaki-ink-3)",
  },
  ".cm-foldGutter .cm-gutterElement:hover": {
    color: "var(--murasaki-primary)",
  },
  ".cm-scroller": {
    overflow: "auto",
    // 字体由 fontComp 动态应用（buildFontTheme），统一各编辑模式使用阅读字体
  },
  ".cm-searchMatch": {
    backgroundColor: "rgba(192, 132, 252, 0.25)",
    outline: "1px solid var(--murasaki-purple-300)",
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "var(--murasaki-purple-300)",
    color: "#fff",
  },
  ".cm-panels": {
    backgroundColor: "var(--murasaki-surface-2)",
    color: "var(--murasaki-ink)",
    borderTop: "1px solid var(--murasaki-line)",
  },
  ".cm-panels input": {
    border: "1px solid var(--murasaki-border)",
    borderRadius: "var(--murasaki-radius-sm)",
    padding: "2px 6px",
    fontSize: "12px",
  },
  ".cm-textfield": {
    backgroundColor: "var(--murasaki-background)",
  },
  ".cm-button": {
    backgroundColor: "var(--murasaki-background)",
    border: "1px solid var(--murasaki-border)",
    borderRadius: "var(--murasaki-radius-sm)",
    color: "var(--murasaki-ink-2)",
    fontSize: "12px",
  },
  ".cm-button:hover": {
    backgroundColor: "var(--murasaki-purple-50)",
    borderColor: "var(--murasaki-primary)",
    color: "var(--murasaki-primary)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--murasaki-popover)",
    border: "1px solid var(--murasaki-border)",
    borderRadius: "var(--murasaki-radius-sm)",
    boxShadow: "var(--murasaki-shadow-md)",
    fontSize: "12px",
  },
  ".cm-tooltip-autocomplete li": {
    padding: "3px 8px",
  },
  ".cm-tooltip-autocomplete li[aria-selected]": {
    backgroundColor: "var(--murasaki-purple-100)",
    color: "var(--murasaki-primary)",
  },
});

interface Props {
  modelValue: string;
  /** 当前 tab id（用于 per-tab EditorState 缓存，保证 undo 栈独立） */
  tabId?: string | null;
  /** 是否显示行号 */
  showLineNumbers?: boolean;
  /** 是否启用软折行 */
  softWrap?: boolean;
  /** 是否只读 */
  readOnly?: boolean;
  /** 编辑模式：source/split/wysiwyg（wysiwyg 叠加 WYSIWYG ViewPlugin，其他模式移除） */
  editorMode?: "source" | "split" | "wysiwyg";
  /** 编辑器字体大小（px） */
  fontSize?: number;
  /** 编辑器行高 */
  lineHeight?: number;
  /** 编辑器等宽字体族 */
  fontFamily?: string;
  /** Markdown 主题（驱动 WYSIWYG 模式下的 --md-* 变量，与预览/导出一致） */
  markdownTheme?: string;
  /** 当前文件路径（用于 WYSIWYG 模式解析相对图片路径，ADR-0015） */
  currentFilePath?: string | null;
  /** 中文符号转 Markdown 记号（行首输入 + 空格自动转换，0.8.0） */
  fullwidthToMarkdown?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  tabId: null,
  showLineNumbers: true,
  softWrap: true,
  readOnly: false,
  editorMode: "split",
  fontSize: 14,
  lineHeight: 1.6,
  fontFamily: "JetBrains Mono",
  markdownTheme: "murasaki",
  currentFilePath: null,
  fullwidthToMarkdown: false,
});

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
  (e: "ready", view: EditorView): void;
  /** 光标位置变化：行（1-indexed）、列（0-indexed） */
  (e: "cursor-change", payload: { line: number; ch: number }): void;
  /** 右键菜单高级操作（插入表格/链接/图片），由父组件处理 */
  (e: "context-action", action: "insert-table" | "insert-link" | "insert-image"): void;
  /** WYSIWYG 模式下 Ctrl+Click 内部 .md 链接：要求父组件在新 tab 中打开 */
  (e: "open-internal", path: string): void;
}>();

const hostRef = ref<HTMLDivElement | null>(null);
const viewRef = shallowRef<EditorView | null>(null);

const contextMenu = useContextMenuStore();
const { t } = useI18n();

// 标记正在进行外部值同步（避免 dispatch 触发 update:modelValue 污染 dirty 状态）
let isApplyingExternalValue = false;

// per-tab EditorState 缓存：切 tab 时保存当前 state（含 undo 栈），切回时恢复
// 解决单 EditorView 共享 undo 栈导致跨 tab undo 撤销错误的问题
const stateCache = new Map<string, EditorState>();
let lastTabId: string | null = null;

// 用 Compartment 让配置可在运行时切换
const lineNumbersComp = new Compartment();
const wrapComp = new Compartment();
const readOnlyComp = new Compartment();
// WYSIWYG ViewPlugin 的叠加/移除通过此 Compartment 运行时切换（不销毁编辑器实例）
const wysiwygComp = new Compartment();
// 字体配置（大小/行高/字体族）通过此 Compartment 运行时切换
const fontComp = new Compartment();
// 语言高亮：非 markdown 文件通过此 Compartment 运行时切换 CodeMirror 语言
const languageComp = new Compartment();
// 快捷键覆盖：settings.shortcuts 变化时重建编辑器快捷键 keymap（shortcutComp）
const shortcutComp = new Compartment();
// 快捷键覆盖表（响应式：设置保存后自动更新）
const { overrides } = useShortcuts();

function buildExtensions() {
  return [
    history(),
    drawSelection(),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    indentOnInput(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    EditorView.lineWrapping, // 默认开启软折行（再由 wrapComp 控制）
    EditorState.allowMultipleSelections.of(true),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    // 快捷键扩展（高优先级，避免被 defaultKeymap 拦截；含 Enter 引用块换行处理）
    // 由设置中的快捷键覆盖动态生成，settings://saved 后通过 shortcutComp 重建
    shortcutComp.of(buildEditorShortcutExtension(overrides.value)),
    // 语言高亮：markdown 走 GFM，其他文本/代码文件走解析出的 CodeMirror 语言
    languageComp.of(buildLanguageExtension()),
    lineNumbersComp.of(props.showLineNumbers ? lineNumbers() : []),
    wrapComp.of(props.softWrap ? EditorView.lineWrapping : []),
    readOnlyComp.of(EditorState.readOnly.of(props.readOnly)),
    // 字体配置（大小/行高/字体族）—— 通过 Compartment 运行时切换
    fontComp.of(buildFontTheme()),
    // WYSIWYG ViewPlugin 仅在 wysiwyg 模式下叠加（运行时通过 Compartment 切换）
    wysiwygComp.of(props.editorMode === "wysiwyg" ? wysiwygExtensions : []),
    // 中文符号转 Markdown 记号（0.8.0）：行首输入全角符号 + 空格自动转换
    // isEnabled / isMarkdown 为实时谓词（读取 props 响应式值），开关/文件切换无需重建扩展
    fullwidthToMarkdownExtension({
      isEnabled: () => props.fullwidthToMarkdown,
      isMarkdown: () =>
        props.currentFilePath
          ? isMarkdownFile(props.currentFilePath)
          : true, // 未命名新文件默认按 markdown 处理（与 App.vue 约定一致）
    }),
    foldGutter({ openText: "▾", closedText: "▸" }),
    murasakiTheme,
    syntaxHighlighting(murasakiHighlightStyle),
    // Agent proposal decorations (Ticket #23)
    proposalField,
    EditorView.updateListener.of((update) => {
      // 外部值同步（watch 触发的 dispatch）不应回传 update:modelValue，
      // 否则切换 tab / 打开文件时会把新激活的 tab 错误标记为 dirty
      if (update.docChanged && !isApplyingExternalValue) {
        emit("update:modelValue", update.state.doc.toString());
      }
      if (update.selectionSet || update.docChanged) {
        const { head } = update.state.selection.main;
        const lineObj = update.state.doc.lineAt(head);
        emit("cursor-change", { line: lineObj.number, ch: head - lineObj.from });
      }
      // Sync proposal store when proposals change (e.g., strict invalidation expires them)
      const hasProposalEffect = update.transactions.some((tr) =>
        tr.effects.some((e) =>
          e.is(addProposalEffect) ||
          e.is(removeProposalEffect) ||
          e.is(expireAllProposalsEffect) ||
          e.is(proposalActionEffect)
        )
      );
      if (update.docChanged || hasProposalEffect) {
        const proposalsStore = useProposalsStore();
        proposalsStore.syncFromEditor();
      }
    }),
  ];
}

/**
 * 构建语言扩展（通过 languageComp 运行时切换）。
 * - 空文件名（未命名新文件）或 markdown 文件 → 走 GFM markdown（含代码块语言支持）
 * - 其他文本/代码文件 → 用 languageForFile 解析出的 CodeMirror 语言；无匹配回退纯文本
 */
function buildLanguageExtension(): Extension {
  const filename = props.currentFilePath ? basename(props.currentFilePath) : "";
  if (filename && !isMarkdownFile(filename)) {
    const desc = languageForFile(filename);
    if (desc && desc.support) {
      return desc.support.language;
    }
    return [];
  }
  return markdown({
    base: markdownLanguage, // 使用带 GFM 的 base（含删除线/任务列表/表格等扩展）
    defaultCodeLanguage: markdownLanguage,
    codeLanguages: languages,
  });
}

/**
 * 构建字体主题（EditorView.theme）。
 * 把 fontSize/lineHeight/fontFamily props 转换为 .cm-content / .cm-scroller 的 CSS。
 * 通过 fontComp 在设置变更时重新应用，无需销毁编辑器实例。
 *
 * 所有编辑模式（source/split/wysiwyg）统一使用阅读字体（与预览一致）。
 * 用户配置的等宽字体作为 fallback（阅读字体缺失时兜底）。
 */
function buildFontTheme() {
  const fontFamily = `var(--murasaki-font-reading, ${props.fontFamily})`;
  const fontCss = `${fontFamily}, ui-monospace, monospace`;
  const sizePx = `${props.fontSize}px`;
  return EditorView.theme({
    ".cm-content": {
      fontFamily: fontCss,
      fontSize: sizePx,
      lineHeight: String(props.lineHeight),
    },
    ".cm-scroller": {
      fontFamily: fontCss,
    },
  });
}

onMounted(() => {
  if (!hostRef.value) return;
  const view = new EditorView({
    state: EditorState.create({
      doc: props.modelValue,
      extensions: buildExtensions(),
    }),
    parent: hostRef.value,
  });
  viewRef.value = view;
  // 初始化 lastTabId，避免首次切 tab 时被 watch modelValue 误处理
  lastTabId = props.tabId ?? null;
  if (props.tabId) {
    stateCache.set(props.tabId, view.state);
  }
  emit("ready", view);
  // 注册到 editor bridge（供 agent 工具使用）
  useEditorBridgeStore().registerView(view);
  // 监听 WYSIWYG 链接 widget 的内部跳转事件（Ctrl+Click 相对 .md 路径）
  // LinkWidget.dispatchEvent 发出自定义事件，这里接收后透传给父组件
  hostRef.value.addEventListener("murasaki-open-internal", ((e: CustomEvent) => {
    emit("open-internal", e.detail as string);
  }) as EventListener);
  // 监听任务列表复选框点击切换事件
  // TaskCheckboxWidget 点击后发出 murasaki-toggle-task，这里 dispatch changes 修改 markdown
  hostRef.value.addEventListener("murasaki-toggle-task", ((e: CustomEvent) => {
    const { from, to, checked } = e.detail as { from: number; to: number; checked: boolean };
    // 替换 [from, to] 范围为 `- [x]` 或 `- [ ]`
    // 原始范围是 ListMark + TaskMarker，如 "- [ ]" 或 "- [x]"
    // 替换为对应的新标记
    const newMark = checked ? "- [x]" : "- [ ]";
    view.dispatch({
      changes: { from, to, insert: newMark },
      userEvent: "input.toggleTask",
    });
  }) as EventListener);
  // 监听 WYSIWYG 表格提交写回（T1.5）：把 DOM 编辑器收集到的新表格源码写回 CM 文档。
  // 走 view.dispatch（默认进入 undo 栈），因此 Edit 可撤销、Ctrl+Z 一处生效（T1.6）。
  hostRef.value.addEventListener("murasaki-table-commit", ((e: CustomEvent) => {
    const { from, to, source, anchorCell } = e.detail as {
      from: number;
      to: number;
      source: string;
      anchorCell?: { row: number; col: number } | null;
    };
    view.dispatch({
      changes: { from, to, insert: source },
      userEvent: "input.tableEdit",
    });
    // 表格块会随源码变化重建。若提交时带锚点坐标，把焦点/光标放回同一个单元格，
    // 实现「Esc 提交并留在表格」；重建为同步完成，若未命中则在下帧重试（不再翻回源码）。
    if (anchorCell) {
      const refocus = (): boolean => {
        const cell = hostRef.value?.querySelector(
          `.murasaki-wysiwyg-table-edit [data-row="${anchorCell.row}"][data-col="${anchorCell.col}"]`
        ) as HTMLTableCellElement | null;
        if (!cell) return false;
        cell.focus();
        const rng = document.createRange();
        rng.selectNodeContents(cell);
        rng.collapse(false);
        const sel = document.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(rng);
        return true;
      };
      if (!refocus()) requestAnimationFrame(() => refocus());
    }
  }) as EventListener);
  // 监听块级 widget 点击事件：把光标定位到块起始位置，触发原始 markdown 编辑
  // CodeBlock/Mermaid/Table/Math widget 点击后发出 murasaki-focus-block
  hostRef.value.addEventListener("murasaki-focus-block", ((e: CustomEvent) => {
    const { from } = e.detail as { from: number };
    view.dispatch({
      selection: { anchor: from },
      scrollIntoView: true,
    });
    view.focus();
  }) as EventListener);
  // 监听 frontmatter 卡片点击事件（T6.2 / #100）：
  // 切换到源码模式（让用户直接编辑 YAML）+ 定位光标到 frontmatter 起始位置
  // setEditorMode 触发 store 反应 → prop 更新 → watch → wysiwygComp.reconfigure 移除 WYSIWYG 扩展
  // view.dispatch 立即设置选区，reconfigure 后选区保留，用户看到源码模式光标在 frontmatter 起始
  hostRef.value.addEventListener("murasaki-focus-frontmatter", ((e: CustomEvent) => {
    const { from } = e.detail as { from: number };
    useEditorBridgeStore().setEditorMode("source");
    view.dispatch({
      selection: { anchor: from },
      scrollIntoView: true,
    });
    view.focus();
  }) as EventListener);
});

onBeforeUnmount(() => {
  if (viewRef.value) {
    useEditorBridgeStore().unregisterView(viewRef.value);
  }
  viewRef.value?.destroy();
  viewRef.value = null;
  stateCache.clear();
});

// 切 tab（tabId 变化）→ 替换整个 EditorState（保留 per-tab undo 栈）
// watch modelValue（tabId 不变）→ dispatch changes 同步外部修改（不进入 undo 栈）
// 两条路径分开处理：切 tab 时不能 dispatch，否则 CodeMirror 的 undo 假设 doc 连续性被打破，
// 会导致 undo 撤销错误内容（用户切回 Tab A 按 undo 会撤销 Tab B 的输入）
watch(
  () => props.tabId,
  (newTabId, oldTabId) => {
    const view = viewRef.value;
    if (!view) return;
    // 保存当前 tab 的 state（含 undo 栈）
    if (oldTabId) {
      stateCache.set(oldTabId, view.state);
    }
    if (!newTabId) {
      // 无激活 tab（不应发生，但容错）
      return;
    }
    // 加载新 tab 的 state
    const cached = stateCache.get(newTabId);
    if (cached) {
      // 先 setState 恢复 cached（含 undo 栈）
      view.setState(cached);
      // 检查 cached doc 是否与 modelValue 一致（外部修改可能已更新 store.content）
      const cachedDoc = cached.doc.toString();
      if (cachedDoc !== props.modelValue) {
        // 外部在切走期间改了内容：dispatch 同步（不污染 undo 栈）
        isApplyingExternalValue = true;
        try {
          view.dispatch({
            changes: { from: 0, to: cachedDoc.length, insert: props.modelValue },
            annotations: Transaction.addToHistory.of(false),
          });
        } finally {
          isApplyingExternalValue = false;
        }
      }
      // 确保 wysiwygComp + fontComp + shortcutComp 与当前配置一致（issue #115）
      // cached state 可能在不同配置下缓存，setState 恢复后需重新应用当前配置
      view.dispatch({
        effects: [
          wysiwygComp.reconfigure(props.editorMode === "wysiwyg" ? wysiwygExtensions : []),
          fontComp.reconfigure(buildFontTheme()),
          shortcutComp.reconfigure(buildEditorShortcutExtension(overrides.value)),
        ],
      });
    } else {
      // 首次进入此 tab：创建新 state
      const newState = EditorState.create({
        doc: props.modelValue,
        extensions: buildExtensions(),
      });
      view.setState(newState);
    }
    lastTabId = newTabId;
  }
);

// 外部值变更（同 tab 内的 reloadFromDisk / 写回合并结果）→ dispatch changes 同步
// 不进入 undo 栈，避免 undo 撤销外部 reload
watch(
  () => props.modelValue,
  (next) => {
    const view = viewRef.value;
    if (!view) return;
    // tabId 切换的同步由上面的 watch 处理，这里跳过
    if (props.tabId !== lastTabId) return;
    const current = view.state.doc.toString();
    if (next !== current) {
      isApplyingExternalValue = true;
      try {
        view.dispatch({
          changes: { from: 0, to: current.length, insert: next },
          annotations: Transaction.addToHistory.of(false),
        });
      } finally {
        isApplyingExternalValue = false;
      }
    }
  }
);

// 配置项变更 → 重新应用对应 Compartment
watch(
  () => props.showLineNumbers,
  (v) => {
    viewRef.value?.dispatch({
      effects: lineNumbersComp.reconfigure(v ? lineNumbers() : []),
    });
  }
);
watch(
  () => props.softWrap,
  (v) => {
    viewRef.value?.dispatch({
      effects: wrapComp.reconfigure(v ? EditorView.lineWrapping : []),
    });
  }
);
watch(
  () => props.readOnly,
  (v) => {
    viewRef.value?.dispatch({
      effects: readOnlyComp.reconfigure(EditorState.readOnly.of(v)),
    });
  }
);

// 编辑模式切换：仅 wysiwyg 叠加 WYSIWYG ViewPlugin，其他模式移除
// 同时重新应用字体主题（WYSIWYG 用阅读字体，source/split 用等宽字体）
// 通过 Compartment.reconfigure 动态切换，不销毁编辑器实例，内容/光标/undo 栈保持不变
watch(
  () => props.editorMode,
  (v) => {
    viewRef.value?.dispatch({
      effects: [
        wysiwygComp.reconfigure(v === "wysiwyg" ? wysiwygExtensions : []),
        fontComp.reconfigure(buildFontTheme()),
      ],
    });
  }
);

// 快捷键覆盖变更（settings://saved 触发 settings.shortcuts 更新）→ 重建编辑器快捷键 keymap
watch(
  () => overrides.value,
  () => {
    viewRef.value?.dispatch({
      effects: shortcutComp.reconfigure(buildEditorShortcutExtension(overrides.value)),
    });
  }
);

// 字体设置变更（大小/行高/字体族）→ 重新应用 fontComp
// 通过 Compartment.reconfigure 动态切换，不销毁编辑器实例
watch(
  [() => props.fontSize, () => props.lineHeight, () => props.fontFamily],
  () => {
    viewRef.value?.dispatch({
      effects: fontComp.reconfigure(buildFontTheme()),
    });
  }
);

// 当前文件路径变更（切 tab / 重命名）→ 更新模块级状态并触发 WYSIWYG 重算 + 语言重配
// ImageWidget 在 toDOM 时读取 currentFilePath 解析相对图片路径（ADR-0015）
watch(
  () => props.currentFilePath,
  (path) => {
    setCurrentFilePath(path);
    // 非 markdown 文件切换 CodeMirror 语言高亮；markdown 保持 GFM
    viewRef.value?.dispatch({ effects: languageComp.reconfigure(buildLanguageExtension()) });
    // 触发 wysiwygField 重算，让 ImageWidget 用新路径重新渲染
    viewRef.value?.dispatch({ effects: recomputeWysiwygEffect.of() });
  },
  { immediate: true }
);

// ===== 右键菜单 =====
function onContextMenu(e: MouseEvent): void {
  const view = viewRef.value;
  if (!view) return;
  contextMenu.show(e, buildEditorMenuItems());
}

function buildEditorMenuItems(): MenuItem[] {
  return [
    { label: t("common.cut"), icon: Scissors, shortcut: formatShortcutForDisplay("Ctrl+X") ?? "", action: () => runExecCommand("cut") },
    { label: t("common.copy"), icon: Copy, shortcut: formatShortcutForDisplay("Ctrl+C") ?? "", action: () => runExecCommand("copy") },
    { label: t("common.paste"), icon: ClipboardPaste, shortcut: formatShortcutForDisplay("Ctrl+V") ?? "", action: () => runExecCommand("paste") },
    { label: t("editor.contextMenu.selectAll"), icon: TextSelect, shortcut: formatShortcutForDisplay("Ctrl+A") ?? "", action: () => runSelectAll() },
    { separator: true },
    { label: t("editor.contextMenu.findReplace"), icon: Search, shortcut: formatShortcutForDisplay("Ctrl+F") ?? "", action: () => runFindReplace() },
    { label: t("editor.toolbar.insertTable"), icon: Table, action: () => emit("context-action", "insert-table") },
    { label: t("editor.contextMenu.link"), icon: LinkIcon, action: () => emit("context-action", "insert-link") },
    { label: t("editor.contextMenu.image"), icon: ImageIcon, action: () => emit("context-action", "insert-image") },
    { label: t("editor.contextMenu.pastePlainText"), icon: Clipboard, action: () => runPastePlainText() },
  ];
}

function runExecCommand(cmd: "cut" | "copy" | "paste"): void {
  const view = viewRef.value;
  if (!view) return;
  view.focus();
  // Tauri WebView 支持原生 execCommand；CM 监听对应的 cut/copy/paste 事件
  try {
    document.execCommand(cmd);
  } catch (err) {
    console.warn(`${cmd} 失败:`, err);
  }
}

function runSelectAll(): void {
  const view = viewRef.value;
  if (!view) return;
  view.focus();
  selectAll(view);
}

function runFindReplace(): void {
  const view = viewRef.value;
  if (!view) return;
  view.focus();
  openSearchPanel(view);
}

async function runPastePlainText(): Promise<void> {
  const view = viewRef.value;
  if (!view) return;
  view.focus();
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
      userEvent: "input.paste",
    });
  } catch (err) {
    console.warn("粘贴纯文本失败:", err);
  }
}

defineExpose({
  focus: () => viewRef.value?.focus(),
  getView: () => viewRef.value,
  /** 返回 CodeMirror 的滚动容器（.cm-scroller），供滚动同步使用 */
  getScrollDom: (): HTMLElement | null => {
    const view = viewRef.value;
    if (!view) return null;
    return view.scrollDOM;
  },
  /** 滚动到指定行号（1-indexed） */
  scrollToLine: (line: number) => {
    const view = viewRef.value;
    if (!view) return;
    const total = view.state.doc.lines;
    const n = Math.max(1, Math.min(line, total));
    const linePos = view.state.doc.line(n).from;
    // 同时移动光标到目标行：WYSIWYG 模式下块级 widget 替换可能导致 scrollIntoView
    // 定位不准，光标定位可强制编辑器滚动到正确位置（大纲跳转 #120）
    view.dispatch({
      selection: { anchor: linePos },
      effects: EditorView.scrollIntoView(linePos, { y: "start" }),
    });
    view.focus();
  },
});
</script>

<template>
  <div
    class="source-editor"
    :class="{ 'mode-wysiwyg': editorMode === 'wysiwyg', 'markdown-body': editorMode === 'wysiwyg' }"
    :data-md-theme="markdownTheme"
    @contextmenu="onContextMenu"
  >
    <div ref="hostRef" class="cm-host"></div>
  </div>
</template>

<style scoped>
.source-editor {
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: var(--murasaki-background);
}
/* WYSIWYG 模式：跟随 markdown 主题（--md-bg / --md-fg），与预览/导出视觉一致 */
.source-editor.mode-wysiwyg {
  background: var(--md-bg, var(--murasaki-background));
  color: var(--md-fg, var(--murasaki-ink));
  font-family: var(--murasaki-font-reading, var(--murasaki-font-ui));
  font-size: 14px;
  line-height: 1.75;
}
.cm-host {
  height: 100%;
  width: 100%;
}
.cm-host :deep(.cm-editor) {
  height: 100%;
  background: var(--murasaki-background);
}
/* WYSIWYG 模式：编辑器背景跟随 --md-bg */
.source-editor.mode-wysiwyg .cm-host :deep(.cm-editor) {
  background: var(--md-bg, var(--murasaki-background));
}
.cm-host :deep(.cm-editor.cm-focused) {
  outline: none;
}
/* 滚动条样式（来自全局变量） */
.cm-host :deep(.cm-scroller)::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
.cm-host :deep(.cm-scroller)::-webkit-scrollbar-thumb {
  background: var(--murasaki-neutral-300);
  border-radius: 5px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
.cm-host :deep(.cm-scroller)::-webkit-scrollbar-thumb:hover {
  background: var(--murasaki-neutral-400);
  background-clip: padding-box;
}

/* 触屏：放大 gutter 触摸区 */
@media (pointer: coarse) {
  .cm-host :deep(.cm-gutters) {
    min-width: 48px;
  }
}
</style>
