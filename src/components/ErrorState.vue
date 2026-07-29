<script setup lang="ts">
/**
 * ErrorState — 错误状态展示组件（议题簇 3 / Ticket #68）
 *
 * 共享 EmptyState 的虚线边框容器视觉，默认 AlertTriangle 黄色图标 + 重试按钮。
 *
 * 注：icon 不走 withDefaults 默认值 —— lucide-vue-next 组件作为 prop 默认值
 * 会在 setup 中触发 getCurrentInstance() 为 undefined（"Cannot destructure
 * property 'slots'"）。改用 computed 回退，行为等价且避开该坑。
 */
import { computed } from "vue";
import type { Component } from "vue";
import { AlertTriangle } from "lucide-vue-next";

interface Props {
  /** 警告图标（默认 AlertTriangle，可覆盖如 FileX / SearchX） */
  icon?: Component;
  /** 主标题 */
  title: string;
  /** 描述文字（可选） */
  description?: string;
  /** 重试按钮文字 */
  retryText?: string;
}

const props = withDefaults(defineProps<Props>(), {
  retryText: "重试",
});

/** 实际渲染的图标：未传则回退到 AlertTriangle */
const effectiveIcon = computed<Component>(() => props.icon ?? AlertTriangle);

const emit = defineEmits<{
  (e: "retry"): void;
}>();

function onRetry(): void {
  emit("retry");
}
</script>

<template>
  <div class="error-state" role="alert" aria-live="assertive">
    <component :is="effectiveIcon" class="error-icon" :size="48" />
    <p class="error-title">{{ title }}</p>
    <p v-if="description" class="error-description">{{ description }}</p>
    <button type="button" class="error-retry" @click="onRetry">
      {{ retryText }}
    </button>
  </div>
</template>

<style scoped>
.error-state {
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
.error-icon {
  color: var(--murasaki-state-warning);
  margin-bottom: 8px;
}
.error-title {
  margin: 12px 0 0;
  font-size: 16px;
  font-weight: 500;
  color: var(--murasaki-foreground);
}
.error-description {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--murasaki-muted-foreground);
}
.error-retry {
  margin-top: 12px;
  padding: 6px 14px;
  border: 1px solid var(--murasaki-primary);
  background: transparent;
  color: var(--murasaki-primary);
  border-radius: var(--murasaki-radius-sm);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background var(--murasaki-transition-fast);
}
.error-retry:hover {
  background: var(--murasaki-purple-50);
}
</style>
