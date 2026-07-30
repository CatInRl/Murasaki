<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { EditorState, Compartment, Transaction } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, selectAll } from "@codemirror/commands";
import { indentOnInput, bracketMatching, foldGutter, foldKeymap, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from "@codemirror/search";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";
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
import { paragraphKeymap } from "../composables/useEditorCommands";
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
import { wysiwygExtensions } from "../editor/wysiwyg/wysiwygPlugin";

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
  { tag: t.heading1, color: "var(--murasaki-purple-700)", fontWeight: "700", fontSize: "1.25em" },
  { tag: t.heading2, color: "var(--murasaki-purple-700)", fontWeight: "700", fontSize: "1.15em" },
  { tag: t.heading3, color: "var(--murasaki-purple-600)", fontWeight: "600", fontSize: "1.05em" },
  { tag: [t.heading4, t.heading5, t.heading6], color: "var(--murasaki-purple-600)", fontWeight: "600" },
  // ATX heading markers (#, ##): purple-400
  { tag: t.heading, color: "var(--murasaki-purple-400)" },
  // Emphasis — 语义 token，随主题切换
  { tag: t.strong, color: "var(--murasaki-ink)", fontWeight: "700" },
  { tag: t.emphasis, color: "var(--murasaki-ink-2)", fontStyle: "italic" },
  { tag: t.strikethrough, color: "var(--murasaki-ink-3)", textDecoration: "line-through" },
  // Links
  { tag: t.link, color: "var(--murasaki-purple-700)", textDecoration: "underline" },
  { tag: t.url, color: "var(--murasaki-state-info)" },
  // Inline code & code blocks
  { tag: t.monospace, color: "var(--murasaki-purple-800)", backgroundColor: "rgba(147, 51, 234, 0.08)" },
  // Lists: purple marker
  { tag: t.list, color: "var(--murasaki-purple-600)" },
  // Quotes: purple-600 italic
  { tag: t.quote, color: "var(--murasaki-purple-600)", fontStyle: "italic" },
  // HR
  { tag: t.separator, color: "var(--murasaki-neutral-300)" },
  // URLs in angle brackets
  { tag: t.angleBracket, color: "var(--murasaki-ink-3)" },
  // YAML frontmatter
  { tag: t.meta, color: "var(--murasaki-muted-foreground)" },
  // Code block keywords
  { tag: t.keyword, color: "var(--murasaki-purple-700)", fontWeight: "600" },
  { tag: t.atom, color: "var(--murasaki-state-info)" },
  { tag: t.bool, color: "var(--murasaki-state-info)" },
  { tag: t.number, color: "var(--murasaki-state-info)" },
  { tag: t.string, color: "var(--murasaki-state-success)" },
  { tag: t.escape, color: "var(--murasaki-state-warning)" },
  { tag: t.comment, color: "var(--murasaki-ink-3)", fontStyle: "italic" },
  { tag: t.tagName, color: "var(--murasaki-purple-700)" },
  { tag: t.attributeName, color: "var(--murasaki-purple-600)" },
  { tag: t.attributeValue, color: "var(--murasaki-state-success)" },
  { tag: t.definitionOperator, color: "var(--murasaki-purple-700)" },
  { tag: t.operator, color: "var(--murasaki-ink-2)" },
  { tag: t.variableName, color: "var(--murasaki-ink)" },
  { tag: t.propertyName, color: "var(--murasaki-purple-600)" },
  { tag: t.typeName, color: "var(--murasaki-state-info)" },
  { tag: t.className, color: "var(--murasaki-purple-700)" },
  { tag: t.function(t.variableName), color: "var(--murasaki-state-info)" },
  { tag: t.labelName, color: "var(--murasaki-purple-600)" },
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
    fontFamily: "var(--murasaki-font-mono)",
    fontSize: "13px",
    lineHeight: "1.65",
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
    fontFamily: "var(--murasaki-font-mono)",
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
}

const props = withDefaults(defineProps<Props>(), {
  tabId: null,
  showLineNumbers: true,
  softWrap: true,
  readOnly: false,
  editorMode: "split",
});

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
  (e: "ready", view: EditorView): void;
  /** 光标位置变化：行（1-indexed）、列（0-indexed） */
  (e: "cursor-change", payload: { line: number; ch: number }): void;
  /** 右键菜单高级操作（插入表格/链接/图片），由父组件处理 */
  (e: "context-action", action: "insert-table" | "insert-link" | "insert-image"): void;
}>();

const hostRef = ref<HTMLDivElement | null>(null);
const viewRef = shallowRef<EditorView | null>(null);

const contextMenu = useContextMenuStore();

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
      // 段落快捷键（Ctrl+1-6/0、Ctrl+Shift+K/Q/X/[/]）
      { key: "Ctrl-f", preventDefault: true, run: openSearchPanel },
      { key: "Ctrl-h", preventDefault: true, run: openSearchPanel },
    ]),
    // 段落格式化快捷键（高优先级，避免被 defaultKeymap 拦截）
    paragraphKeymap(),
    markdown({
      defaultCodeLanguage: markdownLanguage,
      codeLanguages: languages,
    }),
    lineNumbersComp.of(props.showLineNumbers ? lineNumbers() : []),
    wrapComp.of(props.softWrap ? EditorView.lineWrapping : []),
    readOnlyComp.of(EditorState.readOnly.of(props.readOnly)),
    // WYSIWYG ViewPlugin 仅在 wysiwyg 模式下叠加（运行时通过 Compartment 切换）
    wysiwygComp.of(props.editorMode === "wysiwyg" ? wysiwygExtensions : []),
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
// 通过 Compartment.reconfigure 动态切换，不销毁编辑器实例，内容/光标/undo 栈保持不变
watch(
  () => props.editorMode,
  (v) => {
    viewRef.value?.dispatch({
      effects: wysiwygComp.reconfigure(v === "wysiwyg" ? wysiwygExtensions : []),
    });
  }
);

// ===== 右键菜单 =====
function onContextMenu(e: MouseEvent): void {
  const view = viewRef.value;
  if (!view) return;
  contextMenu.show(e, buildEditorMenuItems());
}

function buildEditorMenuItems(): MenuItem[] {
  return [
    { label: "剪切", icon: Scissors, shortcut: "Ctrl+X", action: () => runExecCommand("cut") },
    { label: "复制", icon: Copy, shortcut: "Ctrl+C", action: () => runExecCommand("copy") },
    { label: "粘贴", icon: ClipboardPaste, shortcut: "Ctrl+V", action: () => runExecCommand("paste") },
    { label: "全选", icon: TextSelect, shortcut: "Ctrl+A", action: () => runSelectAll() },
    { separator: true },
    { label: "查找替换", icon: Search, shortcut: "Ctrl+F", action: () => runFindReplace() },
    { label: "插入表格", icon: Table, action: () => emit("context-action", "insert-table") },
    { label: "链接", icon: LinkIcon, action: () => emit("context-action", "insert-link") },
    { label: "图片", icon: ImageIcon, action: () => emit("context-action", "insert-image") },
    { label: "粘贴为纯文本", icon: Clipboard, action: () => runPastePlainText() },
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
    view.dispatch({
      effects: EditorView.scrollIntoView(linePos, { y: "start" }),
    });
  },
});
</script>

<template>
  <div class="source-editor" @contextmenu="onContextMenu">
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
.cm-host {
  height: 100%;
  width: 100%;
}
.cm-host :deep(.cm-editor) {
  height: 100%;
  background: var(--murasaki-background);
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
