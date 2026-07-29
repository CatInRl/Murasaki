<script setup lang="ts">
/**
 * EmptyState — 空状态展示组件（议题簇 3 / Ticket #68）
 *
 * 虚线边框容器 + lucide 图标 + 标题 + 描述 + 可选操作按钮。
 * 替换 naive-ui NEmpty。
 */
import type { Component } from "vue";

interface Props {
  /** lucide 图标组件 */
  icon: Component;
  /** 主标题 */
  title: string;
  /** 描述文字（可选） */
  description?: string;
  /** 操作按钮文字（提供则显示按钮） */
  actionText?: string;
  /** 操作按钮图标（lucide 组件，可选） */
  actionIcon?: Component;
}

defineProps<Props>();

const emit = defineEmits<{
  (e: "action"): void;
}>();

function onAction(): void {
  emit("action");
}
</script>

<template>
  <div class="empty-state" role="status" aria-live="polite">
    <component :is="icon" class="empty-icon" :size="48" />
    <p class="empty-title">{{ title }}</p>
    <p v-if="description" class="empty-description">{{ description }}</p>
    <button
      v-if="actionText"
      type="button"
      class="empty-action"
      @click="onAction"
    >
      <component :is="actionIcon" v-if="actionIcon" :size="14" />
      <span>{{ actionText }}</span>
    </button>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 4px;
  padding: 32px 16px;
  margin: 1rem;
  border: 1px dashed var(--murasaki-border);
  border-radius: var(--murasaki-radius-lg);
  background: transparent;
}
.empty-icon {
  /* text-muted-foreground/50 — 50% alpha over --murasaki-muted-foreground (#737373) */
  color: rgba(115, 115, 115, 0.5);
  margin-bottom: 8px;
}
.empty-title {
  margin: 12px 0 0;
  font-size: 16px;
  font-weight: 500;
  color: var(--murasaki-foreground);
}
.empty-description {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--murasaki-muted-foreground);
}
.empty-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  padding: 6px 14px;
  border: 1px solid var(--murasaki-primary);
  background: transparent;
  color: var(--murasaki-primary);
  border-radius: var(--murasaki-radius-sm);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background var(--murasaki-transition-fast),
              color var(--murasaki-transition-fast);
}
.empty-action:hover {
  background: var(--murasaki-purple-50);
}
</style>
