<script setup lang="ts">
import { computed } from "vue";
import { List } from "lucide-vue-next";
import { NScrollbar } from "naive-ui";
import type { OutlineItem } from "../types";
import { usePersistenceStore } from "../stores/usePersistenceStore";
import EmptyState from "./EmptyState.vue";
import Skeleton from "./Skeleton.vue";

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

const persistence = usePersistenceStore();

/** 长条目显示方案：wrap=自动换行 / hover=省略号+悬停显示完整 */
const wrapMode = computed(() => persistence.settings.entryOverflowMode === "wrap");

/** 计算最小层级（用于缩进归一化） */
const minLevel = computed(() => {
  if (props.items.length === 0) return 1;
  return Math.min(...props.items.map((i) => i.level));
});

/** 归一化层级（1-6） */
function normLevel(level: number): number {
  return Math.max(1, Math.min(6, level - minLevel.value + 1));
}
</script>

<template>
  <div class="outline-panel">
    <div class="outline-toolbar">
      <span class="toolbar-title">{{ $t('editor.outline.title') }}</span>
    </div>

    <NScrollbar class="outline-scroll">
      <Skeleton v-if="loading" :lines="4" />
      <EmptyState
        v-else-if="items.length === 0"
        :icon="List"
        :title="$t('editor.outline.empty')"
        :description="$t('editor.outline.emptyDesc')"
      />
      <div v-else class="outline-content">
        <div
          v-for="(item, idx) in items"
          :key="idx"
          class="outline-item"
          :class="[`level-${normLevel(item.level)}`, { 'wrap-mode': wrapMode }]"
          :style="{ paddingLeft: (item.level - minLevel) * 14 + 12 + 'px' }"
          :title="`${item.text}（${$t('editor.outline.lineTooltip', { line: item.line })}）`"
          @click="emit('jump-to-line', item.line)"
        >
          <span class="outline-dot" aria-hidden="true"></span>
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
  background: var(--murasaki-surface);
}
.outline-toolbar {
  height: 32px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 0 12px;
  border-bottom: 1px solid var(--murasaki-line);
  background: var(--murasaki-surface);
}
.toolbar-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--murasaki-ink-3);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.outline-scroll {
  flex: 1;
  min-height: 0;
}
.outline-content {
  padding: 6px 0;
}

/* === 大纲项：dot 风格，对标设计稿 === */
.outline-item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding-right: 12px;
  cursor: pointer;
  font-size: 13px;
  color: var(--murasaki-ink-2);
  transition: background var(--murasaki-duration-fast) var(--murasaki-ease),
              color var(--murasaki-duration-fast) var(--murasaki-ease);
  overflow: hidden;
  position: relative;
}
.outline-item:hover {
  background: var(--murasaki-neutral-200);
  color: var(--murasaki-ink);
}
.outline-item:active {
  background: var(--murasaki-purple-100);
}

/* 圆点：默认小灰点，h1 大紫点，h2 中紫点 */
.outline-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--murasaki-ink-3);
  flex-shrink: 0;
  transition: background var(--murasaki-duration-fast) var(--murasaki-ease),
              transform var(--murasaki-duration-fast) var(--murasaki-ease);
}
.outline-item:hover .outline-dot {
  transform: scale(1.25);
}

/* 层级样式 */
.outline-item.level-1 {
  font-weight: 600;
  color: var(--murasaki-ink);
}
.outline-item.level-1 .outline-dot {
  width: 6px;
  height: 6px;
  background: var(--murasaki-primary);
  box-shadow: 0 0 0 2px rgba(147, 51, 234, 0.16);
}
.outline-item.level-2 .outline-dot {
  background: var(--murasaki-purple-400);
}
.outline-item.level-3 {
  font-size: 12px;
  color: var(--murasaki-ink-3);
}
.outline-item.level-3 .outline-dot {
  background: var(--murasaki-neutral-400);
}
.outline-item.level-4,
.outline-item.level-5,
.outline-item.level-6 {
  font-size: 12px;
  color: var(--murasaki-ink-3);
}
.outline-item.level-4 .outline-dot,
.outline-item.level-5 .outline-dot,
.outline-item.level-6 .outline-dot {
  width: 3px;
  height: 3px;
  background: var(--murasaki-neutral-400);
}

.outline-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

/* 长条目自动换行方案（设置-编辑器-长条目显示） */
.outline-item.wrap-mode {
  height: auto;
  min-height: 28px;
  padding-top: 4px;
  padding-bottom: 4px;
  overflow: visible;
}
.outline-item.wrap-mode .outline-text {
  white-space: normal;
  overflow: visible;
  text-overflow: clip;
  line-height: 1.35;
  word-break: break-word;
}

/* 触屏：放大行高 */
@media (pointer: coarse) {
  .outline-item {
    height: 36px;
  }
}

/* 紧凑窗口 */
@media (max-width: 980px) {
  .outline-item {
    height: 26px;
    font-size: 12px;
  }
}
</style>
