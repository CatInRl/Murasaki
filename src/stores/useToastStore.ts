import { defineStore } from "pinia";
import { ref } from "vue";

/**
 * 吐司系统 Store（议题簇 2 / Ticket #65）
 *
 * 数据驱动的全局吐司队列。配合 {@link ../components/ToastContainer.vue} 的单一
 * Teleport 容器渲染。6 变体：success / info / warning / error / progress / deleted。
 *
 * 自动消失策略：
 * - success / info：3s
 * - warning / error：5s
 * - progress：持续到调用 dismiss / update 为其他 duration
 * - deleted：10s 或撤销
 *
 * 所有变体均可选 action（如撤销、重试、查看），点击触发回调并关闭吐司。
 */

export type ToastVariant =
  | "success"
  | "info"
  | "warning"
  | "error"
  | "progress"
  | "deleted";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  description?: string;
  action?: ToastAction;
  /** 覆盖自动消失延迟（毫秒）。传 0 表示不自动消失。 */
  duration?: number;
  /** 进度值 0-100，仅 progress 变体使用。 */
  progress?: number;
}

export interface Toast {
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
  action?: ToastAction;
  /** 已解析的自动消失延迟（毫秒）。0 表示不自动消失。 */
  duration: number;
  /** 进度值 0-100（仅 progress 变体）。 */
  progress?: number;
  createdAt: number;
}

/** 各变体默认自动消失延迟（毫秒）；0 表示不自动消失。 */
const DEFAULT_DURATION: Record<ToastVariant, number> = {
  success: 3000,
  info: 3000,
  warning: 5000,
  error: 5000,
  progress: 0,
  deleted: 10000,
};

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `toast-${idCounter}`;
}

export const useToastStore = defineStore("toast", () => {
  const toasts = ref<Toast[]>([]);

  /** 内部计时器映射（非响应式，避免污染状态） */
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleDismiss(id: string, delay: number): void {
    if (delay <= 0) return;
    const timer = setTimeout(() => {
      dismiss(id);
    }, delay);
    timers.set(id, timer);
  }

  function clearTimer(id: string): void {
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(id);
    }
  }

  function push(
    variant: ToastVariant,
    title: string,
    opts?: ToastOptions
  ): string {
    const id = nextId();
    const duration = opts?.duration ?? DEFAULT_DURATION[variant];
    const toast: Toast = {
      id,
      variant,
      title,
      description: opts?.description,
      action: opts?.action,
      duration,
      progress: opts?.progress,
      createdAt: Date.now(),
    };
    toasts.value.push(toast);
    scheduleDismiss(id, duration);
    return id;
  }

  function success(title: string, opts?: ToastOptions): string {
    return push("success", title, opts);
  }

  function info(title: string, opts?: ToastOptions): string {
    return push("info", title, opts);
  }

  function warning(title: string, opts?: ToastOptions): string {
    return push("warning", title, opts);
  }

  function error(title: string, opts?: ToastOptions): string {
    return push("error", title, opts);
  }

  function progress(title: string, opts?: ToastOptions): string {
    return push("progress", title, opts);
  }

  function deleted(title: string, opts?: ToastOptions): string {
    return push("deleted", title, opts);
  }

  function dismiss(id: string): void {
    clearTimer(id);
    const idx = toasts.value.findIndex((t) => t.id === id);
    if (idx !== -1) {
      toasts.value.splice(idx, 1);
    }
  }

  function update(
    id: string,
    patch: Partial<Omit<Toast, "id" | "variant" | "createdAt">>
  ): void {
    const toast = toasts.value.find((t) => t.id === id);
    if (!toast) return;
    Object.assign(toast, patch);
    // 若更新了 duration，重新调度自动消失
    if (patch.duration !== undefined) {
      clearTimer(id);
      scheduleDismiss(id, patch.duration);
    }
  }

  function dismissAll(): void {
    timers.forEach((t) => clearTimeout(t));
    timers.clear();
    toasts.value = [];
  }

  return {
    toasts,
    success,
    info,
    warning,
    error,
    progress,
    deleted,
    dismiss,
    dismissAll,
    update,
  };
});
