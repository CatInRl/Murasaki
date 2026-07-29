<script setup lang="ts">
/**
 * Skeleton — 骨架屏组件（议题簇 3 / Ticket #68）
 *
 * 替换 naive-ui NSpin/NSkeleton 用于加载态。
 * 骨架条宽度按 100%/90%/95%/70% 循环递减模式排列。
 */
import type { Component } from "vue";

interface Props {
  /** 骨架条行数 */
  lines?: number;
  /** 可选前置图标（用于列表项骨架，每行渲染一个） */
  icon?: Component;
}

withDefaults(defineProps<Props>(), {
  lines: 4,
});

/** 宽度模式：100% / 90% / 95% / 70% 循环 */
const WIDTH_PATTERN = [100, 90, 95, 70];

function widthForLine(index: number): string {
  const pct = WIDTH_PATTERN[index % WIDTH_PATTERN.length];
  return `${pct}%`;
}
</script>

<template>
  <div class="skeleton" role="status" aria-live="polite" aria-busy="true">
    <div v-for="i in lines" :key="i" class="skeleton-row">
      <component v-if="icon" :is="icon" class="skeleton-icon" :size="16" />
      <div class="skeleton-bar" :style="{ width: widthForLine(i - 1) }"></div>
    </div>
  </div>
</template>

<style scoped>
.skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
}
.skeleton-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.skeleton-icon {
  color: var(--murasaki-muted-foreground);
  opacity: 0.5;
  flex-shrink: 0;
}
.skeleton-bar {
  height: 16px;
  background: var(--murasaki-muted);
  border-radius: 4px;
  animation: murasaki-skeleton-pulse 1.5s ease-in-out infinite;
}
@keyframes murasaki-skeleton-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}
</style>
