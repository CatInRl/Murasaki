<script setup lang="ts">
/**
 * 对话框容器（Ticket #66 / T2.2）
 *
 * 单一 Teleport 容器，消费 useDialogStore 的模态栈。
 * 同时只显示一个对话框（queue[0]）。
 *
 * 4 类型：alert / confirm / prompt / conflict
 * 按钮顺序：取消在左，确认在右
 * Escape 键等同取消；打开时聚焦默认按钮（取消），prompt 聚焦输入框
 */
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import {
  Info,
  AlertTriangle,
  XCircle,
  Pencil,
  RotateCw,
} from "lucide-vue-next";
import { useDialogStore } from "../stores/useDialogStore";

const dialog = useDialogStore();

// ===== 焦点管理 =====
const cancelBtnRef = ref<HTMLButtonElement | null>(null);
const confirmBtnRef = ref<HTMLButtonElement | null>(null);
const promptInputRef = ref<HTMLInputElement | null>(null);
const renameInputRef = ref<HTMLInputElement | null>(null);

// 当前对话框变化时聚焦默认元素
watch(
  () => dialog.current?.id,
  () => {
    if (!dialog.current) return;
    nextTick(() => {
      const kind = dialog.current?.kind;
      if (kind === "prompt") {
        promptInputRef.value?.focus();
        promptInputRef.value?.select();
      } else if (kind === "conflict" && dialog.current?.showRenameInput) {
        renameInputRef.value?.focus();
        renameInputRef.value?.select();
      } else {
        if (kind === "alert") {
          confirmBtnRef.value?.focus();
        } else {
          cancelBtnRef.value?.focus();
        }
      }
    });
  }
);

// conflict 两步流程：展开重命名输入框时聚焦
watch(
  () => dialog.current?.showRenameInput,
  (v) => {
    if (v) {
      nextTick(() => {
        renameInputRef.value?.focus();
        renameInputRef.value?.select();
      });
    }
  }
);

// ===== Escape 键处理 =====
function onKeydown(e: KeyboardEvent): void {
  if (!dialog.isOpen) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    dialog.cancelCurrent();
    return;
  }
  if (e.key === "Enter") {
    const kind = dialog.current?.kind;
    if (kind === "prompt") {
      e.preventDefault();
      dialog.submitPrompt();
    } else if (kind === "conflict" && dialog.current?.showRenameInput) {
      e.preventDefault();
      dialog.conflictRename();
    }
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown, true);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown, true);
});

// ===== 按钮点击 =====
function onMaskClick(): void {
  dialog.cancelCurrent();
}

function onPromptInput(e: Event): void {
  const val = (e.target as HTMLInputElement).value;
  dialog.updatePromptInput(val);
}

function onRenameInput(e: Event): void {
  const val = (e.target as HTMLInputElement).value;
  dialog.updateConflictRenameInput(val);
}
</script>

<template>
  <Teleport to="body">
    <Transition name="murasaki-dialog">
      <div
        v-if="dialog.current"
        class="dialog-overlay"
        @mousedown.self="onMaskClick"
      >
        <div
          class="dialog-panel"
          role="dialog"
          aria-modal="true"
          :aria-label="dialog.current.title"
        >
          <div class="dialog-header">
            <div class="dialog-icon" :class="`variant-${dialog.current.variant}`">
              <Info v-if="dialog.current.variant === 'info'" :size="20" />
              <AlertTriangle
                v-else-if="dialog.current.variant === 'warning'"
                :size="20"
              />
              <XCircle v-else :size="20" />
            </div>
            <h2 class="dialog-title">{{ dialog.current.title }}</h2>
          </div>

          <div class="dialog-body">
            <p
              v-if="dialog.current.kind === 'alert' || dialog.current.kind === 'confirm'"
              class="dialog-message"
            >{{ dialog.current.message }}</p>

            <template v-if="dialog.current.kind === 'prompt'">
              <p v-if="dialog.current.message" class="dialog-message">{{ dialog.current.message }}</p>
              <input
                ref="promptInputRef"
                class="dialog-input"
                type="text"
                :value="dialog.current.inputValue"
                :placeholder="dialog.current.placeholder"
                @input="onPromptInput"
              />
              <p v-if="dialog.current.validationError" class="dialog-error">
                {{ dialog.current.validationError }}
              </p>
            </template>

            <template v-if="dialog.current.kind === 'conflict'">
              <p class="dialog-message">{{ dialog.current.message }}</p>
              <p v-if="dialog.current.sourcePath" class="dialog-source">
                源：{{ dialog.current.sourcePath }}
              </p>
              <div v-if="dialog.current.showRenameInput" class="conflict-rename">
                <input
                  ref="renameInputRef"
                  class="dialog-input"
                  type="text"
                  :value="dialog.current.inputValue"
                  :placeholder="dialog.current.placeholder"
                  @input="onRenameInput"
                />
                <p v-if="dialog.current.validationError" class="dialog-error">
                  {{ dialog.current.validationError }}
                </p>
              </div>
            </template>
          </div>

          <div class="dialog-footer">
            <template v-if="dialog.current.kind === 'alert'">
              <button
                ref="confirmBtnRef"
                class="dialog-btn primary"
                @click="dialog.confirmCurrent()"
              >
                {{ dialog.current.confirmText }}
              </button>
            </template>

            <template v-else-if="dialog.current.kind === 'confirm'">
              <button
                ref="cancelBtnRef"
                class="dialog-btn"
                @click="dialog.cancelCurrent()"
              >
                {{ dialog.current.cancelText }}
              </button>
              <button
                ref="confirmBtnRef"
                class="dialog-btn primary"
                :class="{ danger: dialog.current.danger }"
                @click="dialog.confirmCurrent()"
              >
                {{ dialog.current.confirmText }}
              </button>
            </template>

            <template v-else-if="dialog.current.kind === 'prompt'">
              <button
                ref="cancelBtnRef"
                class="dialog-btn"
                @click="dialog.cancelCurrent()"
              >
                {{ dialog.current.cancelText }}
              </button>
              <button
                ref="confirmBtnRef"
                class="dialog-btn primary"
                @click="dialog.submitPrompt()"
              >
                {{ dialog.current.confirmText }}
              </button>
            </template>

            <template v-else-if="dialog.current.kind === 'conflict'">
              <button
                ref="cancelBtnRef"
                class="dialog-btn"
                @click="dialog.cancelCurrent()"
              >
                {{ dialog.current.cancelText }}
              </button>
              <button
                class="dialog-btn"
                @click="dialog.conflictRename()"
              >
                <Pencil :size="14" />
                {{ dialog.current.showRenameInput ? "确认重命名" : "重命名" }}
              </button>
              <button
                ref="confirmBtnRef"
                class="dialog-btn danger"
                @click="dialog.conflictOverwrite()"
              >
                <RotateCw :size="14" />
                {{ dialog.current.confirmText }}
              </button>
            </template>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
<style scoped>
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 3000;
  backdrop-filter: blur(2px);
}

.dialog-panel {
  background: var(--murasaki-popover);
  color: var(--murasaki-foreground);
  border: 1px solid var(--murasaki-border);
  border-radius: var(--murasaki-radius-lg);
  box-shadow: var(--murasaki-shadow-2);
  width: min(480px, 92vw);
  max-width: 480px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.dialog-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px 8px;
}

.dialog-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.dialog-icon.variant-info {
  color: var(--murasaki-state-info);
}
.dialog-icon.variant-warning {
  color: var(--murasaki-state-warning);
}
.dialog-icon.variant-error {
  color: var(--murasaki-state-error);
}

.dialog-title {
  font-size: var(--murasaki-text-lg);
  font-weight: 600;
  margin: 0;
  color: var(--murasaki-foreground);
}

.dialog-body {
  padding: 8px 20px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dialog-message {
  font-size: var(--murasaki-text-base);
  color: var(--murasaki-foreground);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}

.dialog-source {
  font-size: var(--murasaki-text-xs);
  color: var(--murasaki-muted-foreground);
  word-break: break-all;
  margin: 0;
}

.dialog-input {
  width: 100%;
  padding: 8px 12px;
  font-size: var(--murasaki-text-base);
  font-family: var(--murasaki-font-ui);
  color: var(--murasaki-foreground);
  background: var(--murasaki-background);
  border: 1px solid var(--murasaki-input);
  border-radius: var(--murasaki-radius-md);
  outline: none;
  transition: border-color var(--murasaki-transition-fast);
}
.dialog-input:focus {
  border-color: var(--murasaki-primary);
  box-shadow: 0 0 0 2px rgba(147, 51, 234, 0.15);
}

.dialog-error {
  font-size: var(--murasaki-text-xs);
  color: var(--murasaki-state-error);
  margin: 0;
}

.conflict-rename {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px 16px;
}

.dialog-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 16px;
  font-size: var(--murasaki-text-sm);
  font-family: var(--murasaki-font-ui);
  color: var(--murasaki-foreground);
  background: var(--murasaki-background);
  border: 1px solid var(--murasaki-border);
  border-radius: var(--murasaki-radius-md);
  cursor: pointer;
  transition: background var(--murasaki-transition-fast),
    border-color var(--murasaki-transition-fast);
  min-width: 72px;
  justify-content: center;
}
.dialog-btn:hover {
  background: var(--murasaki-muted);
}

.dialog-btn.primary {
  background: var(--murasaki-primary);
  color: var(--murasaki-primary-foreground);
  border-color: var(--murasaki-primary);
}
.dialog-btn.primary:hover {
  background: var(--murasaki-purple-700);
}

.dialog-btn.danger {
  background: var(--murasaki-state-error);
  color: #fff;
  border-color: var(--murasaki-state-error);
}
.dialog-btn.danger:hover {
  background: #b91c1c;
}

.murasaki-dialog-enter-active,
.murasaki-dialog-leave-active {
  transition: opacity var(--murasaki-duration-fast) var(--murasaki-ease);
}
.murasaki-dialog-enter-active .dialog-panel,
.murasaki-dialog-leave-active .dialog-panel {
  transition: transform var(--murasaki-duration-base) var(--murasaki-ease-out),
    opacity var(--murasaki-duration-base) var(--murasaki-ease-out);
}
.murasaki-dialog-enter-from,
.murasaki-dialog-leave-to {
  opacity: 0;
}
.murasaki-dialog-enter-from .dialog-panel,
.murasaki-dialog-leave-to .dialog-panel {
  transform: scale(0.96);
  opacity: 0;
}
</style>