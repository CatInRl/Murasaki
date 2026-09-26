<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, computed, ref, watch } from "vue";
import SourceEditor from "./SourceEditor.vue";
import EditorToolbar from "./EditorToolbar.vue";
import PreviewPane from "./PreviewPane.vue";
import HtmlPreview from "./HtmlPreview.vue";
import { useScrollSync } from "../composables/useScrollSync";
import { isHtmlFile, isImageFile } from "../utils/fileKind";
import type { EditorMode } from "../types";

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
  /**
   * 显示模式：
   * - source：纯源码
   * - split：分屏（默认）
   * - wysiwyg：所见即所得
   * - presentation：仅预览（只读演示，不挂编辑器）
   */
  editorMode?: EditorMode;
  /** 编辑器字体大小（px） */
  fontSize?: number;
  /** 编辑器行高 */
  lineHeight?: number;
  /** 编辑器等宽字体族 */
  fontFamily?: string;
  /** 中文符号转 Markdown 记号（行首输入 + 空格自动转换，0.8.0） */
  fullwidthToMarkdown?: boolean;
  /** 演示模式缩放百分比（50–200，默认 100，仅演示模式生效） */
  zoom?: number;
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
  fullwidthToMarkdown: false,
  zoom: 100,
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
  /** 演示模式 Ctrl+滚轮缩放：1=放大，-1=缩小（由父组件夹取边界并持久化） */
  (e: "zoom-step", direction: 1 | -1): void;
}>();

const editorRef = ref<InstanceType<typeof SourceEditor> | null>(null);
const previewRef = ref<
  InstanceType<typeof PreviewPane> | InstanceType<typeof HtmlPreview> | null
>(null);
const cursorKey = ref(0);

/** 是否演示模式（仅预览、只读） */
const isPresentation = computed(() => props.editorMode === "presentation");

/** 演示模式缩放样式：zoom 会把布局尺寸一并放大，故宽高反向除缩放比 */
const zoomStyle = computed<Record<string, string> | undefined>(() => {
  if (!isPresentation.value) return undefined;
  const z = props.zoom / 100;
  if (!Number.isFinite(z) || z === 1) return undefined;
  return { zoom: String(z), width: `calc(100% / ${z})`, height: `calc(100% / ${z})` };
});

/** Ctrl+滚轮缩放（仅演示模式接管，preventDefault 拦截 WebView2 浏览器缩放） */
function onWheel(e: WheelEvent): void {
  if (!isPresentation.value || !e.ctrlKey) return;
  e.preventDefault();
  emit("zoom-step", e.deltaY < 0 ? 1 : -1);
}

/** 当前文件是否为 html（决定右侧预览用 HtmlPreview 渲染原始 HTML） */
const isHtml = computed(() =>
  props.currentFilePath ? isHtmlFile(props.currentFilePath) : false
);

// 分隔条拖拽
// 用 pointer 事件 + setPointerCapture：指针拖入右侧 HtmlPreview(iframe) 时，
// 鼠标事件会被 iframe 吞掉不再送达父文档，导致缩小后无法拖回右侧。
// 指针捕获后事件始终派发给本元素（含越过 iframe / 窗口外），拖拽双向可靠。
const dragging = ref(false);
const leftWidthPct = ref(props.splitRatio * 100);

function onPointerDown(e: PointerEvent) {
  e.preventDefault();
  dragging.value = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
}

function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return;
  const container = document.querySelector(".editor-pane") as HTMLElement | null;
  if (!container) return;
  const rect = container.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  // 限制范围 [0.15, 0.85]
  const clamped = Math.min(0.85, Math.max(0.15, ratio));
  leftWidthPct.value = clamped * 100;
}

function onPointerUp() {
  dragging.value = false;
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  window.removeEventListener("pointercancel", onPointerUp);
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

/** 编辑区拖拽悬停态（落点反馈，issue #151） */
const dropActive = ref(false);

function onEditorDragOver(e: DragEvent): void {
  if (!e.dataTransfer) return;
  const types = e.dataTransfer.types;
  const isTreeDrag = types.includes(FILE_TREE_DRAG_MIME);
  // 外部文件拖入：dragover 不 preventDefault 就可能收不到 drop（WebView2/Chromium 行为），
  // 因此图片文件也要放行；dragover 阶段拿不到 files 时先放行，交给 drop 端按扩展名再校验
  // （否则会在驱动不填 files 时静默收不到 drop，issue #151）
  const files = e.dataTransfer.files;
  const looksLikeImage = files.length === 0 || isImageFile(files[0].name);
  const isExternalImage = types.includes("Files") && looksLikeImage;
  if (!isTreeDrag && !isExternalImage) {
    dropActive.value = false;
    return;
  }
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  dropActive.value = true;
}

/** 离开编辑区或放下后清除落点反馈 */
function onEditorDragLeave(e: DragEvent): void {
  // 掠过编辑区内的子元素也会触发 dragleave：只在真正离开编辑区时才清除
  const next = e.relatedTarget as Node | null;
  const host = e.currentTarget as Node | null;
  if (next && host && host.contains(next)) return;
  dropActive.value = false;
}

function onEditorDrop(e: DragEvent): void {
  dropActive.value = false;
  if (!e.dataTransfer) return;
  const path = e.dataTransfer.getData(FILE_TREE_DRAG_MIME);
  // 外部图片文件不在这里处理：window 级监听器（useImagePaste.handleDrop）负责按
  // 插入方式落图，它还会用落点坐标决定插入位置
  if (!path) return;
  e.preventDefault();
  emit("drop-image-path", path);
}

// 暴露给父组件：滚动到指定行（供大纲跳转使用）
// 演示模式下没有编辑器实例，改为滚动预览容器到对应块级元素
defineExpose({
  scrollToLine: (line: number) => {
    if (isPresentation.value) {
      const preview = previewRef.value as
        | { scrollToSourceLine?: (l: number) => void }
        | null;
      preview?.scrollToSourceLine?.(line);
      return;
    }
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
      v-if="!isPresentation"
      :get-view="() => editorRef?.getView() ?? null"
      :cursor-key="cursorKey"
    />
    <div class="editor-split">
      <div
        v-if="!isPresentation"
        class="pane-left"
        :class="{ 'drop-active': dropActive }"
        :style="{ width: editorMode === 'split' ? leftWidthPct + '%' : '100%' }"
        @dragover="onEditorDragOver"
        @dragleave="onEditorDragLeave"
        @drop="onEditorDrop"
      >
        <!-- 落点反馈：拖拽图片经过编辑区时提示可放下（issue #151） -->
        <div v-if="dropActive" class="drop-hint">
          <span>{{ $t('editor.imageDrop.hint') }}</span>
        </div>
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
          :fullwidth-to-markdown="fullwidthToMarkdown"
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
        @pointerdown="onPointerDown"
      >
        <div class="splitter-handle"></div>
      </div>
      <div
        v-if="editorMode === 'split' || isPresentation"
        class="pane-right"
        :style="{ width: editorMode === 'split' ? `calc(${100 - leftWidthPct}% - 6px)` : '100%' }"
      >
        <!-- 演示模式：缩放包裹层（Ctrl+滚轮 / 快捷键） -->
        <div class="preview-zoom" :style="zoomStyle" @wheel="onWheel">
          <PreviewPane
            v-if="!isHtml"
            ref="previewRef"
            :source="modelValue"
            :theme="previewTheme"
            :current-file-path="currentFilePath"
            :workspace-path="workspacePath"
            :readonly="isPresentation"
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
  position: relative;
  height: 100%;
  overflow: hidden;
  min-width: 100px;
  min-height: 0;
}
/* 拖拽落点反馈（issue #151）：覆盖编辑区的虚线提示，不拦截鼠标事件 */
.drop-hint {
  position: absolute;
  inset: 6px;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px dashed var(--murasaki-primary);
  border-radius: var(--murasaki-radius-md);
  background: color-mix(in srgb, var(--murasaki-primary) 8%, transparent);
  color: var(--murasaki-primary);
  font-size: 13px;
  pointer-events: none;
}
.pane-right {
  height: 100%;
  overflow: hidden;
  min-width: 100px;
  min-height: 0;
}
/* 演示模式缩放包裹层（默认占满；缩放时 inline style 反向除宽高消除 zoom 放大） */
.preview-zoom {
  width: 100%;
  height: 100%;
  overflow: hidden;
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
