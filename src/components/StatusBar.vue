<script setup lang="ts">
import { computed, h, onMounted, ref } from "vue";
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
  MessageSquare,
  Sparkles,
} from "lucide-vue-next";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { useTabsStore } from "../stores/useTabsStore";
import { useAiProvidersStore } from "../stores/useAiProvidersStore";
import { useAgentStore } from "../stores/useAgentStore";
import { basename, dirname } from "../utils/path";
import { AGENT_ENABLED } from "../features";
import type { EditorMode } from "../types";

interface Props {
  filePath: string | null;
  cursorLine: number;
  cursorCol: number;
  charCount: number;
  wordCount: number;
  /** Agent 是否运行中 */
  agentRunning?: boolean;
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
  agentRunning: false,
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
const aiProviders = useAiProvidersStore();
const agentStore = useAgentStore();
const { t } = useI18n();

/** 孤立会话数量（启动时检测，清理后刷新） */
const orphanCount = ref(0);
/** 清理中标志 */
const cleaningOrphans = ref(false);

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

/** 当前活动 provider 名（无则 null） */
const providerName = computed<string | null>(
  () => aiProviders.activeProvider?.name ?? null
);

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

async function refreshOrphans(): Promise<void> {
  try {
    orphanCount.value = await agentStore.checkOrphanChats();
  } catch {
    orphanCount.value = 0;
  }
}

async function onCleanupOrphans(): Promise<void> {
  if (cleaningOrphans.value || orphanCount.value <= 0) return;
  cleaningOrphans.value = true;
  try {
    await agentStore.cleanupOrphanChats();
    await refreshOrphans();
  } finally {
    cleaningOrphans.value = false;
  }
}

onMounted(() => {
  if (!aiProviders.loaded) {
    void aiProviders.load();
  }
  void refreshOrphans();
});
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

    <!-- Agent 运行中指示器 -->
    <div v-if="AGENT_ENABLED && agentRunning" class="status-agent-indicator">
      <span class="status-agent-dot"></span>
      {{ $t('editor.statusBar.agentRunning') }}
    </div>

    <!-- 右侧：显示模式下拉 + 缩放 + 孤立会话清理 + provider chip -->
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

      <button
        v-if="AGENT_ENABLED && orphanCount > 0"
        type="button"
        class="status-orphan"
        :disabled="cleaningOrphans"
        :title="$t('editor.statusBar.orphanTooltip', { count: orphanCount })"
        @click="onCleanupOrphans"
      >
        <MessageSquare :size="14" />
        <span>{{ $t('editor.statusBar.orphanCount', { count: orphanCount }) }}</span>
      </button>

      <div
        v-if="AGENT_ENABLED && providerName"
        class="status-provider-chip"
        :title="$t('editor.statusBar.providerTooltip', { name: providerName })"
      >
        <Sparkles :size="14" />
        <span>{{ providerName }}</span>
      </div>
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

/* 孤立会话清理按钮 */
.status-orphan {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-variant-numeric: tabular-nums;
  color: var(--murasaki-ink-3);
  cursor: pointer;
  transition: color var(--murasaki-transition-fast);
}
.status-orphan:hover:not(:disabled) {
  color: var(--murasaki-primary);
}
.status-orphan:disabled {
  cursor: progress;
  opacity: 0.6;
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

/* Provider chip: bg-primary/10 + text-primary + rounded */
.status-provider-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 8px;
  background: rgba(147, 51, 234, 0.1);
  color: var(--murasaki-primary);
  border-radius: var(--murasaki-radius-sm);
  white-space: nowrap;
}

/* Agent 运行中指示器 */
.status-agent-indicator {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--murasaki-primary, #9333ea);
  font-weight: 500;
  flex-shrink: 0;
  white-space: nowrap;
}
.status-agent-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--murasaki-primary, #9333ea);
  animation: agent-pulse 1.5s ease-in-out infinite;
}
@keyframes agent-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
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
