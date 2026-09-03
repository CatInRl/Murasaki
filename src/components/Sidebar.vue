<script setup lang="ts">
import { toRef, computed } from "vue";
import FileTree from "./FileTree.vue";
import OutlinePanel from "./OutlinePanel.vue";
import { useOutline } from "../composables/useOutline";
import { isMarkdownFile } from "../utils/fileKind";
import type { SidebarView } from "../types";

interface Props {
  /** 当前打开的文件路径（用于大纲解析） */
  currentFilePath?: string | null;
  /** 当前打开文件的实时内容（用于编辑态实时刷新大纲，#170） */
  currentContent?: string;
  /** 侧栏当前视图（受控） */
  activeView?: SidebarView;
  /** 是否已打开工作区（控制"文件树"按钮可见性） */
  hasWorkspace?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  currentFilePath: null,
  currentContent: "",
  activeView: "files",
  hasWorkspace: false,
});

const emit = defineEmits<{
  (e: "select-file", path: string): void;
  (e: "jump-to-line", line: number): void;
  (e: "preview-image", path: string): void;
  (e: "update:activeView", view: SidebarView): void;
}>();

function setView(view: SidebarView): void {
  emit("update:activeView", view);
}

// 大纲：监听当前文件路径，自动拉取
const filePathRef = toRef(props, "currentFilePath");
// 大纲仅对 markdown 文件有意义：非 md 时隐藏大纲 tab，强制文件树视图
const isCurrentMarkdown = computed(() =>
  props.currentFilePath ? isMarkdownFile(props.currentFilePath) : true
);
// 编辑态实时刷新仅在"大纲视图可见"时启用（#170）
const liveOutlineEnabled = computed(
  () => effectiveView(props.activeView) === "outline"
);
const currentContentRef = toRef(props, "currentContent");
const { outline: outlineItems, loading: outlineLoading } = useOutline(
  filePathRef,
  currentContentRef,
  liveOutlineEnabled
);
/** 有效活动视图：非 md 文件始终强制文件树 */
function effectiveView(view: SidebarView): SidebarView {
  return view === "outline" && !isCurrentMarkdown.value ? "files" : view;
}
</script>

<template>
  <div class="sidebar">
    <!-- 顶部切换按钮（图标式 tabs，活跃时显示紫色下划线） -->
    <div class="sidebar-header">
      <button
        v-if="hasWorkspace"
        class="sidebar-tab"
        :class="{ active: effectiveView(activeView) === 'files' }"
        type="button"
        :title="$t('editor.sidebar.filesTab') + ' (Ctrl+Shift+E)'"
        :aria-label="$t('editor.sidebar.filesTabAria')"
        @click="setView('files')"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
          <path d="M3 12h18"/>
        </svg>
      </button>
      <button
        v-if="isCurrentMarkdown"
        class="sidebar-tab"
        :class="{ active: effectiveView(activeView) === 'outline' }"
        type="button"
        :title="$t('editor.sidebar.outlineTab') + ' (Ctrl+Shift+M)'"
        :aria-label="$t('editor.sidebar.outlineTabAria')"
        @click="setView('outline')"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="8" y1="6" x2="21" y2="6"/>
          <line x1="8" y1="12" x2="21" y2="12"/>
          <line x1="8" y1="18" x2="21" y2="18"/>
          <line x1="3" y1="6" x2="3.01" y2="6"/>
          <line x1="3" y1="12" x2="3.01" y2="12"/>
          <line x1="3" y1="18" x2="3.01" y2="18"/>
        </svg>
      </button>
      <div class="sidebar-header-spacer"></div>
    </div>

    <!-- 内容区 -->
    <div class="sidebar-content">
      <transition name="panel-fade" mode="out-in">
        <FileTree
          v-if="effectiveView(activeView) === 'files'"
          key="files"
          @select-file="(p) => emit('select-file', p)"
          @preview-image="(p) => emit('preview-image', p)"
        />
        <OutlinePanel
          v-else
          key="outline"
          :items="outlineItems"
          :loading="outlineLoading"
          @jump-to-line="(line) => emit('jump-to-line', line)"
        />
      </transition>
    </div>
  </div>
</template>

<style scoped>
.sidebar {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--murasaki-surface);
}

.sidebar-header {
  height: var(--murasaki-topbar-height);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 0 8px;
  gap: 2px;
  border-bottom: 1px solid var(--murasaki-line);
  background: var(--murasaki-surface);
  user-select: none;
}

.sidebar-header-spacer {
  flex: 1;
}

.sidebar-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--murasaki-ink-3);
  border-radius: var(--murasaki-radius-sm);
  cursor: pointer;
  position: relative;
  transition: background var(--murasaki-duration-fast) var(--murasaki-ease),
              color var(--murasaki-duration-fast) var(--murasaki-ease);
  padding: 0;
}

.sidebar-tab:hover {
  background: var(--murasaki-neutral-200);
  color: var(--murasaki-ink-2);
}

.sidebar-tab.active {
  color: var(--murasaki-primary);
}

.sidebar-tab.active::after {
  content: '';
  position: absolute;
  bottom: -1px;
  left: 50%;
  transform: translateX(-50%);
  width: 16px;
  height: 2px;
  background: var(--murasaki-primary);
  border-radius: 1px 1px 0 0;
  animation: tab-underline-in var(--murasaki-duration-base) var(--murasaki-ease-out);
}

@keyframes tab-underline-in {
  from { width: 0; opacity: 0; }
  to { width: 16px; opacity: 1; }
}

.sidebar-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  position: relative;
}

/* 切换面板时的过渡动画 */
.panel-fade-enter-active,
.panel-fade-leave-active {
  transition: opacity var(--murasaki-duration-fast) var(--murasaki-ease),
              transform var(--murasaki-duration-fast) var(--murasaki-ease);
}
.panel-fade-enter-from {
  opacity: 0;
  transform: translateY(4px);
}
.panel-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* 触屏：放大点击区 */
@media (pointer: coarse) {
  .sidebar-tab {
    width: 40px;
    height: 36px;
  }
}
</style>
