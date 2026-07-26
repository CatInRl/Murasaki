<script setup lang="ts">
import { computed } from "vue";
import { NText } from "naive-ui";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";

interface Props {
  filePath: string | null;
  cursorLine: number;
  cursorCol: number;
  charCount: number;
  wordCount: number;
}

const props = withDefaults(defineProps<Props>(), {
  filePath: null,
  cursorLine: 0,
  cursorCol: 0,
  charCount: 0,
  wordCount: 0,
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
</script>

<template>
  <div class="status-bar">
    <NText class="status-left" :title="filePath ?? ''">
      {{ displayPath }}
    </NText>
    <NText class="status-right">
      {{ cursorLine }}:{{ cursorCol }} | {{ charCount }} 字符 | {{ wordCount }} 字
    </NText>
  </div>
</template>

<style scoped>
.status-bar {
  height: 22px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  font-size: 12px;
  color: #666;
  background: #fafafa;
  border-top: 1px solid #eee;
  user-select: none;
}
.status-left {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.status-right {
  flex-shrink: 0;
  white-space: nowrap;
  margin-left: 12px;
}
</style>
