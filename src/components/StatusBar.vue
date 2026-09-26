<script setup lang="ts">
import { computed, h } from "vue";
import { useI18n } from "vue-i18n";
import { NDropdown } from "naive-ui";
import {
  FileText,
  AlignLeft,
  Type,
  Hash,
  Check,
  ChevronDown,
  ZoomIn,
  PencilLine,
} from "lucide-vue-next";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { useTabsStore } from "../stores/useTabsStore";
import { basename, dirname } from "../utils/path";
import type { EditorMode } from "../types";

interface Props {
  filePath: string | null;
  cursorLine: number;
  cursorCol: number;
  charCount: number;
  wordCount: number;
  /** 当前生效的显示模式（受文件类型降级后的值） */
  editorMode?: EditorMode;
  /** 演示模式缩放百分比 */
  zoom?: number;
}

const props = withDefaults(defineProps<Props>(), {
  filePath: null,
  cursorLine: 0,
  cursorCol: 0,
  charCount: 0,
  wordCount: 0,
  editorMode: "source",
  zoom: 100,
});

const emit = defineEmits<{
  /** 下拉选中某一显示模式 */
  "select-mode": [mode: EditorMode];
  /** 点击缩放 chip 复位到 100% */
  "zoom-reset": [];
}>();

const workspace = useWorkspaceStore();
const tabs = useTabsStore();
const { t } = useI18n();

/**
 * 相对工作区根的文件路径；无文件时显示"未打开文件"
 */
const displayPath = computed<string>(() => {
  if (!props.filePath) return t("common.status.noFileOpen");
  const root = workspace.workspacePath;
  if (!root) return props.filePath;
  const normRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  const normPath = props.filePath.replace(/\\/g, "/");
  if (normPath.startsWith(normRoot + "/")) {
    return normPath.slice(normRoot.length + 1);
  }
  return props.filePath;
});

const fileName = computed(() =>
  props.filePath ? basename(displayPath.value) : t("common.status.noFileOpen")
);
const fileDir = computed(() => {
  if (!props.filePath) return "";
  return dirname(displayPath.value);
});

/**
 * 已保存指示状态：
 * - 无打开文件 / 无活动 tab：不显示
 * - 有未保存改动（isDirty）：显示"未保存"
 * - 已保存：显示"已保存"（check + text-state-success）
 */
const savedState = computed<"saved" | "unsaved" | "none">(() => {
  if (!props.filePath) return "none";
  const tab = tabs.activeTab;
  if (!tab) return "none";
  return tab.isDirty ? "unsaved" : "saved";
});

/** 显示模式顺序 + 文案 key（下拉项按此顺序渲染，复用菜单文案） */
const MODE_LABEL_KEYS: Record<EditorMode, string> = {
  source: "menu.view.modeSource",
  split: "menu.view.modeSplit",
  wysiwyg: "menu.view.modeWysiwyg",
  presentation: "menu.view.modePresentation",
};

/** 当前模式显示名 */
const modeLabel = computed(() => t(MODE_LABEL_KEYS[props.editorMode]));

/**
 * 模式下拉项：点击 chip 弹出四选一（当前项打勾），不做循环切换。
 * 文件类型降级（source-only / html）仍以 props.editorMode 为准。
 */
const modeOptions = computed(() =>
  (Object.keys(MODE_LABEL_KEYS) as EditorMode[]).map((mode) => ({
    key: mode,
    label: t(MODE_LABEL_KEYS[mode]),
    icon: mode === props.editorMode ? () => h(Check, { size: 14 }) : undefined,
  }))
);

/** 演示模式：显示缩放 chip */
const isPresentation = computed(() => props.editorMode === "presentation");

function onModeSelect(key: string): void {
  if (key === props.editorMode) return;
  emit("select-mode", key as EditorMode);
}
</script>

<template>
  <div class="status-bar">
    <!-- 文件路径 -->
    <div class="status-path" :title="filePath ?? ''">
      <FileText class="status-icon" :size="14" />
      <span class="status-filename">{{ fileName }}</span>
      <span v-if="fileDir" class="status-sep">/</span>
      <span v-if="fileDir" class="status-dir">{{ fileDir }}</span>
    </div>

    <!-- 光标位置 -->
    <div class="status-group">
      <AlignLeft class="status-icon" :size="14" />
      <span>{{ $t('editor.statusBar.lineCol', { line: cursorLine, col: cursorCol }) }}</span>
    </div>

    <!-- 字数（CJK 逐字 + 拉丁逐词） -->
    <div class="status-group">
      <Type class="status-icon" :size="14" />
      <span>{{ $t('editor.statusBar.wordCount', { count: wordCount }) }}</span>
    </div>

    <!-- 字符数（不含空白字符） -->
    <div class="status-group">
      <Hash class="status-icon" :size="14" />
      <span>{{ $t('editor.statusBar.charCount', { count: charCount }) }}</span>
    </div>

    <!-- 已保存指示：check + text-state-success -->
    <div
      v-if="savedState === 'saved'"
      class="status-group status-saved"
      :title="$t('common.status.savedTooltip')"
    >
      <Check :size="14" />
      <span>{{ $t('common.status.saved') }}</span>
    </div>
    <div
      v-else-if="savedState === 'unsaved'"
      class="status-group status-unsaved"
      :title="$t('common.status.unsavedTooltip')"
    >
      <PencilLine :size="14" />
      <span>{{ $t('common.status.unsaved') }}</span>
    </div>

    <!-- 右侧：显示模式下拉 + 缩放 -->
    <div class="status-right">
      <!-- 显示模式：点击弹出四选一下拉（不循环切换） -->
      <NDropdown
        trigger="click"
        placement="top-start"
        :options="modeOptions"
        @select="onModeSelect"
      >
        <button
          type="button"
          class="status-chip status-mode-chip"
          :title="$t('editor.statusBar.modeTooltip')"
        >
          <span>{{ modeLabel }}</span>
          <ChevronDown :size="12" />
        </button>
      </NDropdown>

      <!-- 演示模式：缩放百分比（点击复位 100%） -->
      <button
        v-if="isPresentation"
        type="button"
        class="status-chip status-zoom-chip"
        :title="$t('editor.statusBar.zoomTooltip')"
        @click="emit('zoom-reset')"
      >
        <ZoomIn :size="14" />
        <span>{{ $t('editor.statusBar.zoomLabel', { percent: zoom }) }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.status-bar {
  height: var(--murasaki-statusbar-height);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 12px;
  font-size: var(--murasaki-text-xs);
  color: var(--murasaki-ink-3);
  background: var(--murasaki-surface);
  border-top: 1px solid var(--murasaki-line);
  user-select: none;
  font-variant-numeric: tabular-nums;
}

.status-path {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
}

.status-group {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  white-space: nowrap;
}

.status-icon {
  color: var(--murasaki-ink-3);
  flex-shrink: 0;
}

.status-filename {
  color: var(--murasaki-ink-2);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-dir {
  color: var(--murasaki-ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-sep {
  color: var(--murasaki-neutral-300);
  flex-shrink: 0;
}

/* 已保存：check + text-state-success */
.status-saved {
  color: var(--murasaki-state-success);
}

/* 未保存 */
.status-unsaved {
  color: var(--murasaki-state-warning);
}

/* 右侧区域：推到状态栏最右 */
.status-right {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-left: auto;
  flex-shrink: 0;
}

/* 显示模式 / 缩放 chip：透明底，hover 变主色 */
.status-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: none;
  border: none;
  padding: 1px 6px;
  font: inherit;
  font-variant-numeric: tabular-nums;
  color: var(--murasaki-ink-3);
  border-radius: var(--murasaki-radius-sm);
  cursor: pointer;
  white-space: nowrap;
  transition: color var(--murasaki-transition-fast),
              background var(--murasaki-transition-fast);
}
.status-chip:hover {
  color: var(--murasaki-primary);
  background: rgba(147, 51, 234, 0.1);
}

/* 紧凑模式 */
@media (max-width: 980px) {
  .status-bar {
    padding: 0 8px;
    gap: 12px;
  }
}

/* 极窄：收紧间距 */
@media (max-width: 720px) {
  .status-bar {
    gap: 8px;
  }
}
</style>
