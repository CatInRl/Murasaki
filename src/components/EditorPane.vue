<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, computed, ref, watch } from "vue";
import SourceEditor from "./SourceEditor.vue";
import EditorToolbar from "./EditorToolbar.vue";
import PreviewPane from "./PreviewPane.vue";
import HtmlPreview from "./HtmlPreview.vue";
import { useScrollSync } from "../composables/useScrollSync";
import { isHtmlFile } from "../utils/fileKind";

interface Props {
  modelValue: string;
  /** 当前 tab id（透传给 SourceEditor 用于 per-tab EditorState 缓存） */
  tabId?: string | null;
  /** 分屏比例（编辑器占比 0-1） */
  splitRatio?: number;
  /** 是否显示行号 */
  showLineNumbers?: boolean;
  /** 是否软折行 */
  softWrap?: boolean;
  /** 预览主题 */
  previewTheme?: string;
  /** 当前文件路径（用于解析相对 .md 链接） */
  currentFilePath?: string | null;
  /** 工作区根路径（用于解析相对 .md 链接） */
  workspacePath?: string | null;
  /** 编辑模式：source（纯源码）/ split（分屏，默认）/ wysiwyg（所见即所得，预览区隐藏） */
  editorMode?: "source" | "split" | "wysiwyg";
  /** 编辑器字体大小（px） */
  fontSize?: number;
  /** 编辑器行高 */
  lineHeight?: number;
  /** 编辑器等宽字体族 */
  fontFamily?: string;
}

const props = withDefaults(defineProps<Props>(), {
  tabId: null,
  splitRatio: 0.5,
  showLineNumbers: true,
  softWrap: true,
  previewTheme: "murasaki",
  currentFilePath: null,
  workspacePath: null,
  editorMode: "split",
  fontSize: 14,
  lineHeight: 1.6,
  fontFamily: "JetBrains Mono",
});

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
  (e: "cursor-change", payload: { line: number; ch: number }): void;
  /** 内部 .md 链接点击：要求父组件在新 tab 中打开 */
  (e: "open-internal", path: string): void;
  /** 从文件树拖入图片：要求父组件插入相对路径引用 */
  (e: "drop-image-path", path: string): void;
  /** 编辑器右键菜单高级操作（插入表格/链接/图片） */
  (e: "context-action", action: "insert-table" | "insert-link" | "insert-image"): void;
}>();

const editorRef = ref<InstanceType<typeof SourceEditor> | null>(null);
const previewRef = ref<
  InstanceType<typeof PreviewPane> | InstanceType<typeof HtmlPreview> | null
>(null);
const cursorKey = ref(0);

/** 当前文件是否为 html（决定右侧预览用 HtmlPreview 渲染原始 HTML） */
const isHtml = computed(() =>
  props.currentFilePath ? isHtmlFile(props.currentFilePath) : false
);

// 分隔条拖拽
const dragging = ref(false);
const leftWidthPct = ref(props.splitRatio * 100);

function onMouseDown(e: MouseEvent) {
  e.preventDefault();
  dragging.value = true;
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
}

function onMouseMove(e: MouseEvent) {
  if (!dragging.value) return;
  const container = document.querySelector(".editor-pane") as HTMLElement | null;
  if (!container) return;
  const rect = container.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  // 限制范围 [0.15, 0.85]
  const clamped = Math.min(0.85, Math.max(0.15, ratio));
  leftWidthPct.value = clamped * 100;
}

function onMouseUp() {
  dragging.value = false;
  window.removeEventListener("mousemove", onMouseMove);
  window.removeEventListener("mouseup", onMouseUp);
}

function onInput(value: string) {
  emit("update:modelValue", value);
}

function onCursorChange(payload: { line: number; ch: number }) {
  emit("cursor-change", payload);
  cursorKey.value++;
}

// ============ 滚动同步 ============
// 仅在 split 模式下绑定（source/wysiwyg 无预览区）
let detachScrollSync: (() => void) | null = null;

const scrollSync = useScrollSync({
  editorView: () => editorRef.value?.getView() ?? null,
  previewScroller: () => previewRef.value?.getScrollDom() ?? null,
  throttleMs: 50,
});

function detachScrollSyncIfAny(): void {
  if (detachScrollSync) {
    detachScrollSync();
    detachScrollSync = null;
  }
}

function attachScrollSyncForSplit(): void {
  detachScrollSyncIfAny();
  if (props.editorMode !== "split" || isHtml.value) return;
  const editorScrollDom = editorRef.value?.getScrollDom() ?? null;
  const previewScrollDom = previewRef.value?.getScrollDom() ?? null;
  detachScrollSync = scrollSync.attach(editorScrollDom, previewScrollDom);
}

onMounted(() => {
  // 等待 CodeMirror 与预览容器都就绪后再绑定（仅 split 模式）
  void nextTick(() => attachScrollSyncForSplit());
});

// 模式切换时重新绑定/解绑滚动同步：
// - 进入 split：等 PreviewPane 渲染就绪后绑定
// - 离开 split：立即解绑（预览区将卸载）
watch(
  () => props.editorMode,
  (mode) => {
    if (mode === "split") {
      void nextTick(() => attachScrollSyncForSplit());
    } else {
      detachScrollSyncIfAny();
    }
  }
);

onBeforeUnmount(() => {
  detachScrollSyncIfAny();
});

// ============ 任务列表复选框切换 ============
// 预览区点击 task list checkbox → 找到对应源码行 → 切换 [ ] ↔ [x]
function onTaskToggle(payload: { li: HTMLElement; checked: boolean }) {
  const { li, checked } = payload;
  const sourceLineAttr = li.getAttribute("data-source-line");
  if (!sourceLineAttr) return;
  const lineNumber = parseInt(sourceLineAttr, 10);
  if (Number.isNaN(lineNumber)) return;

  const source = props.modelValue;
  const lines = source.split("\n");
  // data-source-line 是 li 起始行（1-indexed）；任务标记可能就在该行或后续行
  // 在 [lineNumber-1, lineNumber+2] 范围内查找任务标记
  const startIdx = Math.max(0, lineNumber - 1);
  const endIdx = Math.min(lines.length, lineNumber + 2);

  let changed = false;
  // 任务标记正则：匹配 - [ ] 或 - [x]（含 * 前缀、缩进）
  const taskMarker = /^(\s*[-*+]\s+\[)([ xX])(\])/;
  for (let i = startIdx; i < endIdx; i++) {
    const match = lines[i].match(taskMarker);
    if (match) {
      // 检查当前状态是否与目标状态不一致
      const currentChecked = match[2] === "x" || match[2] === "X";
      if (currentChecked !== checked) {
        const newMark = checked ? "x" : " ";
        lines[i] = lines[i].replace(taskMarker, `$1${newMark}$3`);
        changed = true;
      }
      break;
    }
  }

  if (changed) {
    emit("update:modelValue", lines.join("\n"));
  }
}

// ============ 文件树拖入图片处理 ============
// spec：从工作区文件树拖入已有图片 → 计算相对当前 .md 文件的路径 → 插入 ![](<relative-path>)
// 与粘贴/外部拖入不同：不复制，直接以相对路径引用
const FILE_TREE_DRAG_MIME = "application/x-murasaki-file-path";

function onEditorDragOver(e: DragEvent): void {
  if (!e.dataTransfer) return;
  // 仅当携带文件树自定义 MIME 时允许 drop
  const types = e.dataTransfer.types;
  if (types.includes(FILE_TREE_DRAG_MIME)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
}

function onEditorDrop(e: DragEvent): void {
  if (!e.dataTransfer) return;
  const path = e.dataTransfer.getData(FILE_TREE_DRAG_MIME);
  if (!path) return;
  e.preventDefault();
  emit("drop-image-path", path);
}

// 暴露给父组件：滚动到指定行（供大纲跳转使用）
defineExpose({
  scrollToLine: (line: number) => {
    editorRef.value?.scrollToLine(line);
  },
  focus: () => {
    editorRef.value?.focus();
  },
  getView: () => editorRef.value?.getView() ?? null,
});
</script>

<template>
  <div class="editor-pane" :class="`mode-${editorMode}`">
    <EditorToolbar
      :get-view="() => editorRef?.getView() ?? null"
      :cursor-key="cursorKey"
    />
    <div class="editor-split">
      <div
        class="pane-left"
      :style="{ width: editorMode === 'split' ? leftWidthPct + '%' : '100%' }"
      @dragover="onEditorDragOver"
      @drop="onEditorDrop"
    >
      <SourceEditor
        ref="editorRef"
        :model-value="modelValue"
        :tab-id="tabId"
        :show-line-numbers="showLineNumbers"
        :soft-wrap="softWrap"
        :editor-mode="editorMode"
        :font-size="fontSize"
        :line-height="lineHeight"
        :font-family="fontFamily"
        :markdown-theme="previewTheme"
        :current-file-path="currentFilePath"
        :read-only="isHtml"
        @update:model-value="onInput"
        @cursor-change="onCursorChange"
        @context-action="(a) => emit('context-action', a)"
        @open-internal="(p) => emit('open-internal', p)"
      />
    </div>
    <div
      v-if="editorMode === 'split'"
      class="splitter"
      :class="{ dragging }"
      @mousedown="onMouseDown"
    >
      <div class="splitter-handle"></div>
    </div>
    <div
      v-if="editorMode === 'split'"
      class="pane-right"
      :style="{ width: `calc(${100 - leftWidthPct}% - 6px)` }"
    >
      <PreviewPane
        v-if="!isHtml"
        ref="previewRef"
        :source="modelValue"
        :theme="previewTheme"
        :current-file-path="currentFilePath"
        :workspace-path="workspacePath"
        @task-toggle="onTaskToggle"
        @open-internal="(p) => emit('open-internal', p)"
      />
      <HtmlPreview
        v-else
        ref="previewRef"
        :source="modelValue"
      />
    </div>
    </div>
  </div>
</template>

<style scoped>
.editor-pane {
  display: flex;
  flex-direction: column;
  width: 100%;
  /* 高度由父级 flex 约束；min-height: 0 允许在 flex 容器中正确收缩 */
  flex: 1;
  min-height: 0;
  overflow: hidden;
  position: relative;
  background: var(--murasaki-background);
}
.editor-split {
  display: flex;
  flex: 1;
  min-height: 0;
  width: 100%;
  overflow: hidden;
}

.pane-left {
  height: 100%;
  overflow: hidden;
  min-width: 100px;
  min-height: 0;
}
.pane-right {
  height: 100%;
  overflow: hidden;
  min-width: 100px;
  min-height: 0;
}
.splitter {
  width: 1px;
  height: 100%;
  background: var(--murasaki-line);
  cursor: col-resize;
  position: relative;
  flex-shrink: 0;
  user-select: none;
  transition: background var(--murasaki-duration-fast) var(--murasaki-ease);
}
/* 拖拽热区比视觉宽度更宽，便于抓取 */
.splitter::before {
  content: '';
  position: absolute;
  inset: 0 -4px;
}
.splitter::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 7px;
  height: 36px;
  border-radius: 4px;
  background: transparent;
  transition: background var(--murasaki-duration-fast) var(--murasaki-ease),
              opacity var(--murasaki-duration-fast) var(--murasaki-ease);
  pointer-events: none;
}
.splitter:hover::after,
.splitter.dragging::after {
  background: var(--murasaki-primary);
  opacity: 0.18;
}
.splitter.dragging {
  background: var(--murasaki-purple-200);
}
.splitter-handle {
  display: none;
}

/* 触屏：增加热区宽度 */
@media (pointer: coarse) {
  .splitter {
    width: 3px;
  }
  .splitter::before {
    inset: 0 -8px;
  }
}
</style>
