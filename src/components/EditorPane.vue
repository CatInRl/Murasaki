<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import SourceEditor from "./SourceEditor.vue";
import PreviewPane from "./PreviewPane.vue";
import { useScrollSync } from "../composables/useScrollSync";

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
}

const props = withDefaults(defineProps<Props>(), {
  tabId: null,
  splitRatio: 0.5,
  showLineNumbers: true,
  softWrap: true,
  previewTheme: "github",
  currentFilePath: null,
  workspacePath: null,
});

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
  (e: "cursor-change", payload: { line: number; ch: number }): void;
  /** 内部 .md 链接点击：要求父组件在新 tab 中打开 */
  (e: "open-internal", path: string): void;
  /** 从文件树拖入图片：要求父组件插入相对路径引用 */
  (e: "drop-image-path", path: string): void;
}>();

const editorRef = ref<InstanceType<typeof SourceEditor> | null>(null);
const previewRef = ref<InstanceType<typeof PreviewPane> | null>(null);

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
}

// ============ 滚动同步 ============
let detachScrollSync: (() => void) | null = null;

const scrollSync = useScrollSync({
  editorView: () => editorRef.value?.getView() ?? null,
  previewScroller: () => previewRef.value?.getScrollDom() ?? null,
  throttleMs: 50,
});

onMounted(() => {
  // 等待 CodeMirror 与预览容器都就绪后再绑定
  void nextTick(() => {
    const editorScrollDom = editorRef.value?.getScrollDom() ?? null;
    const previewScrollDom = previewRef.value?.getScrollDom() ?? null;
    detachScrollSync = scrollSync.attach(editorScrollDom, previewScrollDom);
  });
});

onBeforeUnmount(() => {
  if (detachScrollSync) {
    detachScrollSync();
    detachScrollSync = null;
  }
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
  <div class="editor-pane">
    <div
      class="pane-left"
      :style="{ width: leftWidthPct + '%' }"
      @dragover="onEditorDragOver"
      @drop="onEditorDrop"
    >
      <SourceEditor
        ref="editorRef"
        :model-value="modelValue"
        :tab-id="tabId"
        :show-line-numbers="showLineNumbers"
        :soft-wrap="softWrap"
        @update:model-value="onInput"
        @cursor-change="onCursorChange"
      />
    </div>
    <div
      class="splitter"
      :class="{ dragging }"
      @mousedown="onMouseDown"
    >
      <div class="splitter-handle"></div>
    </div>
    <div class="pane-right" :style="{ width: `calc(${100 - leftWidthPct}% - 6px)` }">
      <PreviewPane
        ref="previewRef"
        :source="modelValue"
        :theme="previewTheme"
        :current-file-path="currentFilePath"
        :workspace-path="workspacePath"
        @task-toggle="onTaskToggle"
        @open-internal="(p) => emit('open-internal', p)"
      />
    </div>
  </div>
</template>

<style scoped>
.editor-pane {
  display: flex;
  width: 100%;
  /* 高度由父级 flex 约束；min-height: 0 允许在 flex 容器中正确收缩 */
  flex: 1;
  min-height: 0;
  overflow: hidden;
  position: relative;
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
  width: 6px;
  height: 100%;
  background: #e0e0e6;
  cursor: col-resize;
  position: relative;
  flex-shrink: 0;
  user-select: none;
  transition: background 0.15s;
}
.splitter:hover, .splitter.dragging {
  background: #18a058;
}
.splitter-handle {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 2px;
  height: 32px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 1px;
}
</style>
