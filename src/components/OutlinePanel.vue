<script setup lang="ts">
import { computed } from "vue";
import { NScrollbar, NEmpty, NSpin } from "naive-ui";
import type { OutlineItem } from "../types";

interface Props {
  /** 大纲数据 */
  items: OutlineItem[];
  /** 加载中 */
  loading?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  loading: false,
});

const emit = defineEmits<{
  (e: "jump-to-line", line: number): void;
}>();

/** 计算最小层级（用于缩进归一化） */
const minLevel = computed(() => {
  if (props.items.length === 0) return 1;
  return Math.min(...props.items.map((i) => i.level));
});
</script>

<template>
  <div class="outline-panel">
    <div class="outline-toolbar">
      <span class="toolbar-title">大纲</span>
    </div>

    <NScrollbar class="outline-scroll">
      <div v-if="loading" class="outline-loading">
        <NSpin size="small" />
        <span style="margin-left: 8px; font-size: 12px; color: #999">解析中…</span>
      </div>
      <NEmpty
        v-else-if="items.length === 0"
        description="无标题"
        size="small"
        style="padding: 24px 0"
      />
      <div v-else class="outline-content">
        <div
          v-for="(item, idx) in items"
          :key="idx"
          class="outline-item"
          :style="{ paddingLeft: (item.level - minLevel) * 14 + 8 + 'px' }"
          :title="`第 ${item.line} 行`"
          @click="emit('jump-to-line', item.line)"
        >
          <span class="outline-marker">H{{ item.level }}</span>
          <span class="outline-text">{{ item.text }}</span>
        </div>
      </div>
    </NScrollbar>
  </div>
</template>

<style scoped>
.outline-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.outline-toolbar {
  height: 32px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 0 8px;
  border-bottom: 1px solid #eee;
}
.toolbar-title {
  font-size: 12px;
  font-weight: 600;
  color: #333;
}
.outline-scroll {
  flex: 1;
  min-height: 0;
}
.outline-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 0;
}
.outline-content {
  padding: 4px 0;
}
.outline-item {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding-right: 8px;
  cursor: pointer;
  font-size: 13px;
  color: #333;
  border-radius: 3px;
  transition: background 0.1s;
  overflow: hidden;
}
.outline-item:hover {
  background: rgba(0, 0, 0, 0.05);
}
.outline-marker {
  font-size: 10px;
  color: #999;
  background: #f0f0f0;
  padding: 1px 4px;
  border-radius: 2px;
  flex-shrink: 0;
  font-family: monospace;
}
.outline-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
