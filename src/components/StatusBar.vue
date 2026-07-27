<script setup lang="ts">
import { computed } from "vue";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { basename, dirname } from "../utils/path";

interface Props {
  filePath: string | null;
  cursorLine: number;
  cursorCol: number;
  charCount: number;
  wordCount: number;
  /** Agent 是否运行中 */
  agentRunning?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  filePath: null,
  cursorLine: 0,
  cursorCol: 0,
  charCount: 0,
  wordCount: 0,
  agentRunning: false,
});

const workspace = useWorkspaceStore();

/**
 * 相对工作区根的文件路径；无文件时显示"未打开文件"
 */
const displayPath = computed<string>(() => {
  if (!props.filePath) return "未打开文件";
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
  props.filePath ? basename(displayPath.value) : "未打开文件"
);
const fileDir = computed(() => {
  if (!props.filePath) return "";
  return dirname(displayPath.value);
});
</script>

<template>
  <div class="status-bar">
    <div class="status-left" :title="filePath ?? ''">
      <svg class="status-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <span class="status-filename">{{ fileName }}</span>
      <span v-if="fileDir" class="status-sep">/</span>
      <span v-if="fileDir" class="status-dir">{{ fileDir }}</span>
      <span v-if="agentRunning" class="status-agent-indicator">
        <span class="status-agent-dot"></span>
        Agent 运行中
      </span>
    </div>
    <div class="status-right">
      <span class="status-chip">
        <span class="status-chip-label">行</span>
        <span class="status-chip-value">{{ cursorLine }}</span>
      </span>
      <span class="status-sep-v">·</span>
      <span class="status-chip">
        <span class="status-chip-label">列</span>
        <span class="status-chip-value">{{ cursorCol }}</span>
      </span>
      <span class="status-sep-v">·</span>
      <span class="status-chip">
        <span class="status-chip-value">{{ charCount }}</span>
        <span class="status-chip-label">字符</span>
      </span>
      <span class="status-sep-v">·</span>
      <span class="status-chip">
        <span class="status-chip-value">{{ wordCount }}</span>
        <span class="status-chip-label">字</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.status-bar {
  height: var(--murasaki-statusbar-height);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  font-size: 12px;
  color: var(--murasaki-ink-3);
  background: var(--murasaki-surface);
  border-top: 1px solid var(--murasaki-line);
  user-select: none;
  font-variant-numeric: tabular-nums;
}

.status-left {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
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
}

.status-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  white-space: nowrap;
  margin-left: 12px;
}

.status-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.status-chip-label {
  color: var(--murasaki-ink-3);
  font-size: 11px;
}

.status-chip-value {
  color: var(--murasaki-ink-2);
  font-weight: 500;
}

.status-sep-v {
  color: var(--murasaki-neutral-300);
  margin: 0 2px;
}

/* Agent 运行中指示器 */
.status-agent-indicator {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--murasaki-primary, #9333ea);
  font-weight: 500;
  margin-left: 8px;
  padding-left: 8px;
  border-left: 1px solid var(--murasaki-line);
}
.status-agent-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--murasaki-primary, #9333ea);
  animation: agent-pulse 1.5s ease-in-out infinite;
}
@keyframes agent-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* 紧凑模式：隐藏列号 chip，节省空间 */
@media (max-width: 980px) {
  .status-bar {
    padding: 0 8px;
    font-size: 11px;
  }
  .status-right {
    gap: 6px;
  }
}

/* 极窄：仅显示行号与字符数 */
@media (max-width: 720px) {
  .status-chip:nth-of-type(3),
  .status-sep-v:nth-of-type(3) {
    display: none;
  }
}
</style>
