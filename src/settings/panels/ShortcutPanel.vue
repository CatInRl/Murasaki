<script setup lang="ts">
/**
 * ShortcutPanel — 快捷键设置面板（issue #97）
 *
 * 按功能分类展示所有可自定义快捷键（单一事实源 shortcutRegistry）：
 * - 文件 / 编辑 / 段落 / 视图 / Agent
 *
 * 交互：
 * - 点击快捷键徽标进入录制态，按下组合键完成录制（Esc 取消）
 * - 行尾图标：恢复该命令默认绑定 / 禁用该命令快捷键
 * - 与默认绑定不同的命令会实时提示与其他命令的绑定冲突
 *
 * 通过 v-model 写回 SettingsApp 的 draft（显式 Save 模型，保存才落盘）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RotateCcw, X } from "lucide-vue-next";
import type { SettingsState } from "../../types";
import {
  CATEGORY_ORDER,
  SHORTCUT_COMMANDS,
  type ShortcutCommand,
} from "../../shortcuts/shortcutRegistry";
import {
  detectConflicts,
  effectiveShortcuts,
  eventToShortcut,
  formatShortcutForDisplay,
  isDefaultShortcut,
  isUsableShortcut,
  resetShortcutOverride,
  setShortcutOverride,
} from "../../shortcuts/shortcutsLogic";

const props = defineProps<{ modelValue: SettingsState }>();
const emit = defineEmits<{ "update:modelValue": [SettingsState] }>();

const { t } = useI18n();

const draft = computed(() => props.modelValue);

function patchShortcuts(next: Record<string, string | null>): void {
  emit("update:modelValue", { ...draft.value, shortcuts: next });
}

/** 命令 ID → 有效绑定（默认或覆盖） */
const effective = computed(() => effectiveShortcuts(draft.value.shortcuts));

/** 命令 ID → 与之共享同一绑定的其他命令（冲突提示用） */
const conflictMap = computed(() => {
  const map = new Map<string, ShortcutCommand[]>();
  for (const conflict of detectConflicts(draft.value.shortcuts)) {
    for (const cmd of conflict.commands) {
      const others = conflict.commands.filter((c) => c.id !== cmd.id);
      map.set(cmd.id, others);
    }
  }
  return map;
});

/** 按分类分组（CATEGORY_ORDER 排序，跳过空组） */
const groups = computed(() =>
  CATEGORY_ORDER.map((category) => ({
    category,
    label: t(`settings.shortcuts.categories.${category}`),
    list: SHORTCUT_COMMANDS.filter((c) => c.category === category),
  })).filter((g) => g.list.length > 0)
);

function conflictText(cmd: ShortcutCommand): string {
  const others = conflictMap.value.get(cmd.id) ?? [];
  if (others.length === 0) return "";
  const names = others.map((c) => t(c.labelKey)).join("、");
  return t("settings.shortcuts.conflict", { commands: names });
}

// ===== 录制 =====

/** 正在录制快捷键的命令 ID（null=无） */
const recordingId = ref<string | null>(null);
/** 无效组合提示（如无修饰符的字符键） */
const invalidHint = ref<string | null>(null);

function toggleRecord(cmdId: string): void {
  recordingId.value = recordingId.value === cmdId ? null : cmdId;
  invalidHint.value = null;
}

function stopRecord(): void {
  recordingId.value = null;
  invalidHint.value = null;
}

function onRecordKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    stopRecord();
    return;
  }
  const shortcut = eventToShortcut(e);
  if (!shortcut) return; // 纯修饰键按下，等待完整组合
  if (!isUsableShortcut(shortcut)) {
    // 无修饰符的字符键会吞掉打字，不允许作为绑定
    invalidHint.value = t("settings.shortcuts.invalidHint");
    return;
  }
  const cmdId = recordingId.value!;
  patchShortcuts(setShortcutOverride(draft.value.shortcuts, cmdId, shortcut));
  stopRecord();
}

/** 录制期间全局捕获 keydown（阻止应用/浏览器默认行为，如 Ctrl+W 关窗） */
function onCaptureKeydown(e: KeyboardEvent): void {
  if (!recordingId.value) return;
  e.preventDefault();
  e.stopPropagation();
  onRecordKeydown(e);
}

onMounted(() => window.addEventListener("keydown", onCaptureKeydown, true));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onCaptureKeydown, true);
  stopRecord();
});

// ===== 行操作 =====

function restoreOne(cmdId: string): void {
  patchShortcuts(resetShortcutOverride(draft.value.shortcuts, cmdId));
}

function disableOne(cmdId: string): void {
  patchShortcuts(setShortcutOverride(draft.value.shortcuts, cmdId, null));
}
</script>

<template>
  <div>
    <h1 class="settings-page-title">{{ t('settings.shortcuts.title') }}</h1>
    <p class="settings-page-description">{{ t('settings.shortcuts.description') }}</p>

    <p v-if="invalidHint" class="shortcut-hint" role="alert">
      {{ invalidHint }}
    </p>

    <div v-for="group in groups" :key="group.category" class="settings-section">
      <h2 class="settings-section-title">{{ group.label }}</h2>
      <div class="shortcut-list">
        <div
          v-for="cmd in group.list"
          :key="cmd.id"
          class="shortcut-row"
          :class="{ 'is-recording': recordingId === cmd.id }"
        >
          <div class="shortcut-info">
            <span class="shortcut-label">{{ t(cmd.labelKey) }}</span>
            <span v-if="conflictMap.get(cmd.id)?.length" class="shortcut-conflict">
              {{ conflictText(cmd) }}
            </span>
          </div>

          <div class="shortcut-actions">
            <button
              type="button"
              class="shortcut-key-btn"
              :class="{ recording: recordingId === cmd.id }"
              :title="t('settings.shortcuts.recordTitle')"
              @click="toggleRecord(cmd.id)"
            >
              <template v-if="recordingId === cmd.id">
                {{ t('settings.shortcuts.recording') }}
              </template>
              <template v-else-if="effective[cmd.id]">
                {{ formatShortcutForDisplay(effective[cmd.id]) }}
              </template>
              <template v-else>
                <span class="unset">{{ t('settings.shortcuts.unset') }}</span>
              </template>
            </button>

            <button
              v-if="!isDefaultShortcut(draft.shortcuts, cmd.id)"
              type="button"
              class="icon-button"
              :title="t('settings.shortcuts.restoreDefault')"
              :aria-label="t('settings.shortcuts.restoreDefault')"
              @click="restoreOne(cmd.id)"
            >
              <RotateCcw :size="14" />
            </button>
            <button
              v-if="effective[cmd.id]"
              type="button"
              class="icon-button"
              :title="t('settings.shortcuts.disable')"
              :aria-label="t('settings.shortcuts.disable')"
              @click="disableOne(cmd.id)"
            >
              <X :size="14" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-page-description {
  margin: -12px 0 20px;
  color: var(--murasaki-ink-3, #999);
  font-size: 13px;
  line-height: 1.5;
}
.shortcut-hint {
  margin: 0 0 16px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--murasaki-error, #d93025);
  background: color-mix(in srgb, var(--murasaki-error, #d93025) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--murasaki-error, #d93025) 35%, transparent);
  border-radius: var(--murasaki-radius-md, 6px);
}
.shortcut-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.shortcut-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 8px 12px;
  border-radius: var(--murasaki-radius-sm, 4px);
  transition: background-color 0.15s ease;
}
.shortcut-row:hover {
  background-color: var(--murasaki-surface-2, #f5f5f5);
}
.shortcut-row.is-recording {
  background-color: var(--murasaki-purple-50, #f3f0ff);
}
.shortcut-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.shortcut-label {
  font-size: 14px;
  color: var(--murasaki-ink, #333);
}
.shortcut-conflict {
  font-size: 12px;
  color: var(--murasaki-error, #d93025);
}
.shortcut-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.shortcut-key-btn {
  display: inline-flex;
  align-items: center;
  min-width: 96px;
  min-height: 24px;
  justify-content: center;
  padding: 2px 10px;
  font-family: var(--murasaki-font-mono, monospace);
  font-size: 12px;
  font-weight: 500;
  color: var(--murasaki-ink-2, #666);
  background: var(--murasaki-surface, #fff);
  border: 1px solid var(--murasaki-border, #e0e0e0);
  border-radius: 4px;
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.05);
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.shortcut-key-btn:hover {
  border-color: var(--murasaki-ring, #7c6cf0);
  color: var(--murasaki-ink, #333);
}
.shortcut-key-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--murasaki-ring, #7c6cf0);
}
.shortcut-key-btn.recording {
  border-color: var(--murasaki-primary, #7c6cf0);
  color: var(--murasaki-primary, #7c6cf0);
  background: var(--murasaki-purple-50, #f3f0ff);
}
.shortcut-key-btn .unset {
  color: var(--murasaki-ink-3, #999);
  font-family: var(--murasaki-font-ui, sans-serif);
  font-weight: 400;
}
.icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: var(--murasaki-ink-3, #999);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--murasaki-radius-sm, 4px);
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}
.icon-button:hover {
  color: var(--murasaki-ink, #333);
  background: var(--murasaki-surface-2, #f5f5f5);
}
.icon-button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--murasaki-ring, #7c6cf0);
}
</style>
