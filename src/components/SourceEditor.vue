<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { EditorState, Compartment, Transaction } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { indentOnInput, bracketMatching, foldGutter, foldKeymap } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from "@codemirror/search";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { paragraphKeymap } from "../composables/useEditorCommands";

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
}

const props = withDefaults(defineProps<Props>(), {
  tabId: null,
  showLineNumbers: true,
  softWrap: true,
  readOnly: false,
});

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
  (e: "ready", view: EditorView): void;
  /** 光标位置变化：行（1-indexed）、列（0-indexed） */
  (e: "cursor-change", payload: { line: number; ch: number }): void;
}>();

const hostRef = ref<HTMLDivElement | null>(null);
const viewRef = shallowRef<EditorView | null>(null);

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
    foldGutter({ openText: "▾", closedText: "▸" }),
    oneDark,
    EditorView.theme({
      "&": {
        height: "100%",
        fontSize: "14px",
      },
      ".cm-gutters": {
        borderRight: "1px solid #2d2d44",
      },
      ".cm-content": {
        fontFamily: "Consolas, 'Courier New', monospace",
        padding: "8px 0",
      },
      ".cm-scroller": {
        overflow: "auto",
      },
    }),
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
});

onBeforeUnmount(() => {
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
  <div class="source-editor">
    <div ref="hostRef" class="cm-host"></div>
  </div>
</template>

<style scoped>
.source-editor {
  height: 100%;
  width: 100%;
  overflow: hidden;
}
.cm-host {
  height: 100%;
  width: 100%;
}
.cm-host :deep(.cm-editor) {
  height: 100%;
}
</style>
