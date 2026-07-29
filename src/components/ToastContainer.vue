<script setup lang="ts">
/**
 * 吐司容器（议题簇 2 / Ticket #65）
 *
 * 单一 Teleport 容器，渲染 {@link ../stores/useToastStore} 中的全局吐司队列。
 * 固定在视口右上角，纵向堆叠。6 变体：success / info / warning / error /
 * progress / deleted，各自匹配语义色与 lucide 图标。
 *
 * 交互：
 * - 点击关闭按钮（X）调用 dismiss(id)
 * - 点击 action 按钮触发回调并关闭吐司
 * - progress 变体显示进度条（0-100%）
 * - deleted 变体突出撤销 action
 */
import { computed } from "vue";
import {
  CheckCircle2,
  Info,
  AlertTriangle,
  XCircle,
  Loader2,
  Trash2,
  X,
} from "lucide-vue-next";
import { useToastStore, type ToastVariant } from "../stores/useToastStore";

const toastStore = useToastStore();

/** 变体 → 图标组件映射 */
const ICON_BY_VARIANT: Record<ToastVariant, typeof CheckCircle2> = {
  success: CheckCircle2,
  info: Info,
  warning: AlertTriangle,
  error: XCircle,
  progress: Loader2,
  deleted: Trash2,
};

/** 变体 → 语义色 CSS 变量映射 */
const COLOR_BY_VARIANT: Record<ToastVariant, string> = {
  success: "var(--murasaki-state-success)",
  info: "var(--murasaki-state-info)",
  warning: "var(--murasaki-state-warning)",
  error: "var(--murasaki-state-error)",
  progress: "var(--murasaki-primary)",
  deleted: "var(--murasaki-state-warning)",
};

const toasts = computed(() => toastStore.toasts);

/** 点击 action：触发回调并关闭吐司 */
function onAction(id: string, onClick: () => void): void {
  onClick();
  toastStore.dismiss(id);
}
</script>

<template>
  <Teleport to="body">
    <div class="toast-container" role="region" aria-label="通知" aria-live="polite">
      <transition-group name="toast">
        <div
          v-for="toast in toasts"
          :key="toast.id"
          class="toast-item"
          :class="`toast-${toast.variant}`"
          :style="{ '--toast-color': COLOR_BY_VARIANT[toast.variant] }"
          role="alert"
        >
          <component
            :is="ICON_BY_VARIANT[toast.variant]"
            class="toast-icon"
            :class="{ 'toast-icon-spin': toast.variant === 'progress' }"
            :size="18"
          />
          <div class="toast-body">
            <div class="toast-title">{{ toast.title }}</div>
            <div v-if="toast.description" class="toast-desc">
              {{ toast.description }}
            </div>
            <!-- 进度条（仅 progress 变体） -->
            <div
              v-if="toast.variant === 'progress'"
              class="toast-progress-track"
            >
              <div
                class="toast-progress-bar"
                :style="{ width: `${Math.max(0, Math.min(100, toast.progress ?? 0))}%` }"
              />
            </div>
          </div>
          <div class="toast-actions">
            <button
              v-if="toast.action"
              type="button"
              class="toast-action-btn"
              @click="onAction(toast.id, toast.action!.onClick)"
            >
              {{ toast.action.label }}
            </button>
            <button
              type="button"
              class="toast-close-btn"
              aria-label="关闭通知"
              @click="toastStore.dismiss(toast.id)"
            >
              <X :size="14" />
            </button>
          </div>
        </div>
      </transition-group>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-container {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 380px;
  pointer-events: none;
}

.toast-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  background: var(--murasaki-popover);
  color: var(--murasaki-popover-foreground);
  border: 1px solid var(--murasaki-line);
  border-left: 3px solid var(--toast-color);
  border-radius: var(--murasaki-radius-md);
  box-shadow: var(--murasaki-shadow-md);
  pointer-events: auto;
  font-size: var(--murasaki-text-sm);
  line-height: 1.4;
}

.toast-icon {
  color: var(--toast-color);
  flex-shrink: 0;
  margin-top: 1px;
}

.toast-icon-spin {
  animation: murasaki-spin 1s linear infinite;
}

@keyframes murasaki-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.toast-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.toast-title {
  font-weight: 600;
  color: var(--murasaki-ink);
  word-break: break-word;
}

.toast-desc {
  font-size: var(--murasaki-text-xs);
  color: var(--murasaki-ink-2);
  word-break: break-word;
}

.toast-progress-track {
  margin-top: 4px;
  height: 4px;
  background: var(--murasaki-surface-2);
  border-radius: 2px;
  overflow: hidden;
}

.toast-progress-bar {
  height: 100%;
  background: var(--toast-color);
  border-radius: 2px;
  transition: width var(--murasaki-duration-base) var(--murasaki-ease);
}

.toast-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.toast-action-btn {
  border: 1px solid var(--toast-color);
  background: transparent;
  color: var(--toast-color);
  font-size: var(--murasaki-text-xs);
  font-weight: 600;
  padding: 3px 8px;
  border-radius: var(--murasaki-radius-sm);
  cursor: pointer;
  transition: background var(--murasaki-duration-fast) var(--murasaki-ease);
}

.toast-action-btn:hover {
  background: color-mix(in srgb, var(--toast-color) 12%, transparent);
}

.toast-close-btn {
  border: none;
  background: transparent;
  color: var(--murasaki-ink-3);
  cursor: pointer;
  width: 20px;
  height: 20px;
  border-radius: var(--murasaki-radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background var(--murasaki-duration-fast) var(--murasaki-ease),
    color var(--murasaki-duration-fast) var(--murasaki-ease);
}

.toast-close-btn:hover {
  background: var(--murasaki-surface-2);
  color: var(--murasaki-ink);
}

/* transition-group 进入/离开动画 */
.toast-enter-active {
  transition: opacity var(--murasaki-duration-base) var(--murasaki-ease-out),
    transform var(--murasaki-duration-base) var(--murasaki-ease-out);
}

.toast-leave-active {
  transition: opacity var(--murasaki-duration-fast) var(--murasaki-ease),
    transform var(--murasaki-duration-fast) var(--murasaki-ease);
  position: absolute;
  right: 0;
}

.toast-enter-from {
  opacity: 0;
  transform: translateX(16px);
}

.toast-leave-to {
  opacity: 0;
  transform: translateX(16px);
}

.toast-move {
  transition: transform var(--murasaki-duration-base) var(--murasaki-ease);
}
</style>
