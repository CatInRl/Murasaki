<script setup lang="ts">
import { ref, computed, watch } from "vue";
import {
  NModal,
  NButton,
  NSpace,
  NForm,
  NFormItem,
  NRadioGroup,
  NRadio,
  NSwitch,
  NText,
  NTag,
  NDivider,
  NAlert,
} from "naive-ui";
import { usePersistenceStore } from "../stores/usePersistenceStore";
import { MARKDOWN_THEMES } from "../composables/useTheme";
import type { SettingsState } from "../types";

interface Props {
  visible: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: "close"): void;
  /** 设置变更（含字段名） */
  (e: "change", field: keyof SettingsState, value: unknown): void;
}>();

const persistence = usePersistenceStore();

/**
 * 当前编辑中的设置（本地副本，取消时不回写）
 */
const draft = ref<SettingsState>({ ...persistence.settings });

// 每次打开时同步最新持久化值
watch(
  () => props.visible,
  (v) => {
    if (v) {
      draft.value = { ...persistence.settings };
      activeCategory.value = "appearance";
    }
  }
);

// ===== 分类导航 =====
type Category = "appearance" | "editor" | "files";

const activeCategory = ref<Category>("appearance");

const categories: Array<{ key: Category; label: string; icon: string }> = [
  { key: "appearance", label: "外观", icon: "🎨" },
  { key: "editor", label: "编辑", icon: "✏️" },
  { key: "files", label: "文件", icon: "📁" },
];

// ===== 主题选项 =====
const themeOptions = MARKDOWN_THEMES.map((t) => ({
  label: t.label,
  value: t.name,
}));

// ===== UI 模式选项 =====
const uiModeOptions: Array<{ label: string; value: SettingsState["uiMode"] }> = [
  { label: "亮色", value: "light" },
  { label: "暗色", value: "dark" },
  { label: "跟随系统", value: "system" },
];

// ===== 编辑模式选项 =====
const editorModeOptions: Array<{
  label: string;
  value: SettingsState["editorMode"];
  description: string;
}> = [
  {
    label: "分屏编辑",
    value: "split",
    description: "左侧源码、右侧预览（当前默认）",
  },
  {
    label: "所见即所得（WYSIWYG）",
    value: "wysiwyg",
    description: "占位符，后续版本支持（切换需重启应用生效）",
  },
];

// ===== 是否有未保存变更 =====
const isDirty = computed(() => {
  const a = draft.value;
  const b = persistence.settings;
  return (
    a.uiMode !== b.uiMode ||
    a.editorMode !== b.editorMode ||
    a.showLineNumbers !== b.showLineNumbers ||
    a.softWrap !== b.softWrap ||
    a.showHiddenFiles !== b.showHiddenFiles ||
    a.markdownTheme !== b.markdownTheme ||
    a.sidebarView !== b.sidebarView
  );
});

/** 标记某字段是否与持久化值不同（用于显示"已修改"徽章） */
function isFieldDirty(field: keyof SettingsState): boolean {
  return (
    JSON.stringify(draft.value[field]) !==
    JSON.stringify(persistence.settings[field])
  );
}

// ===== 应用单个字段变更（实时持久化） =====
async function applyField<K extends keyof SettingsState>(
  field: K,
  value: SettingsState[K]
): Promise<void> {
  draft.value = { ...draft.value, [field]: value };
  await persistence.updateSettings({ [field]: value } as Partial<SettingsState>);
  emit("change", field, value);
}

// ===== 表单变更处理 =====
async function onUiModeChange(value: SettingsState["uiMode"]): Promise<void> {
  await applyField("uiMode", value);
}

async function onEditorModeChange(
  value: SettingsState["editorMode"]
): Promise<void> {
  await applyField("editorMode", value);
}

async function onShowLineNumbersChange(value: boolean): Promise<void> {
  await applyField("showLineNumbers", value);
}

async function onSoftWrapChange(value: boolean): Promise<void> {
  await applyField("softWrap", value);
}

async function onShowHiddenFilesChange(value: boolean): Promise<void> {
  await applyField("showHiddenFiles", value);
}

async function onMarkdownThemeChange(value: string): Promise<void> {
  await applyField("markdownTheme", value);
}

// ===== 关闭 =====
function onClose(): void {
  emit("close");
}

// ===== UI 模式提示 =====
const uiModeNotice = computed(() => {
  if (draft.value.uiMode !== persistence.settings.uiMode) {
    return "UI 模式切换将在重启应用后完全生效（当前仅影响部分组件）。";
  }
  return "";
});
</script>

<template>
  <NModal
    :show="visible"
    :mask-closable="true"
    :close-on-esc="true"
    preset="card"
    title="设置"
    style="width: 720px; max-width: 92vw"
    @esc="onClose"
    @update:show="(v: boolean) => !v && onClose()"
  >
    <div class="settings-layout">
      <!-- 左侧分类导航 -->
      <div class="settings-nav">
        <div
          v-for="cat in categories"
          :key="cat.key"
          class="nav-item"
          :class="{ active: activeCategory === cat.key }"
          @click="activeCategory = cat.key"
        >
          <span class="nav-icon">{{ cat.icon }}</span>
          <span class="nav-label">{{ cat.label }}</span>
        </div>
      </div>

      <!-- 右侧表单 -->
      <div class="settings-content">
        <!-- 外观 -->
        <div v-if="activeCategory === 'appearance'" class="category-pane">
          <h3 class="pane-title">外观</h3>
          <NAlert v-if="uiModeNotice" type="info" :show-icon="true" style="margin-bottom: 16px">
            {{ uiModeNotice }}
          </NAlert>
          <NForm label-placement="top">
            <NFormItem label="UI 模式">
              <NRadioGroup
                :value="draft.uiMode"
                @update:value="onUiModeChange"
              >
                <NSpace>
                  <NRadio
                    v-for="opt in uiModeOptions"
                    :key="opt.value"
                    :value="opt.value"
                  >
                    {{ opt.label }}
                  </NRadio>
                </NSpace>
              </NRadioGroup>
            </NFormItem>
            <NFormItem label="Markdown 主题（预览样式）">
              <NRadioGroup
                :value="draft.markdownTheme"
                @update:value="onMarkdownThemeChange"
              >
                <NSpace wrap>
                  <NRadio
                    v-for="opt in themeOptions"
                    :key="opt.value"
                    :value="opt.value"
                  >
                    {{ opt.label }}
                  </NRadio>
                </NSpace>
              </NRadioGroup>
            </NFormItem>
          </NForm>
        </div>

        <!-- 编辑 -->
        <div v-else-if="activeCategory === 'editor'" class="category-pane">
          <h3 class="pane-title">编辑</h3>
          <NForm label-placement="top">
            <NFormItem label="编辑模式">
              <NRadioGroup
                :value="draft.editorMode"
                @update:value="onEditorModeChange"
              >
                <div class="radio-list">
                  <div
                    v-for="opt in editorModeOptions"
                    :key="opt.value"
                    class="radio-row"
                  >
                    <NRadio :value="opt.value">
                      <span class="radio-label">{{ opt.label }}</span>
                    </NRadio>
                    <NText depth="3" class="radio-desc">
                      {{ opt.description }}
                    </NText>
                  </div>
                </div>
              </NRadioGroup>
            </NFormItem>
            <NDivider />
            <NFormItem label="显示行号">
              <NSwitch
                :value="draft.showLineNumbers"
                @update:value="onShowLineNumbersChange"
              />
              <NTag
                v-if="isFieldDirty('showLineNumbers')"
                size="small"
                type="warning"
                style="margin-left: 12px"
              >
                已修改
              </NTag>
            </NFormItem>
            <NFormItem label="启用软折行">
              <NSwitch
                :value="draft.softWrap"
                @update:value="onSoftWrapChange"
              />
              <NTag
                v-if="isFieldDirty('softWrap')"
                size="small"
                type="warning"
                style="margin-left: 12px"
              >
                已修改
              </NTag>
            </NFormItem>
          </NForm>
        </div>

        <!-- 文件 -->
        <div v-else-if="activeCategory === 'files'" class="category-pane">
          <h3 class="pane-title">文件</h3>
          <NForm label-placement="top">
            <NFormItem label="显示隐藏文件">
              <NSwitch
                :value="draft.showHiddenFiles"
                @update:value="onShowHiddenFilesChange"
              />
              <NText depth="3" class="form-hint">
                开启后文件树将显示以 . 开头的文件和目录
              </NText>
            </NFormItem>
          </NForm>
          <NAlert type="info" :show-icon="true" style="margin-top: 16px">
            切换此选项后请刷新文件树（点击文件树顶部 ↻ 按钮或右键 → 刷新）以应用变更。
          </NAlert>
        </div>
      </div>
    </div>

    <template #footer>
      <NSpace justify="end">
        <NText v-if="isDirty" depth="3" class="dirty-hint">
          变更已自动保存
        </NText>
        <NButton @click="onClose">关闭</NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.settings-layout {
  display: flex;
  min-height: 360px;
  max-height: 60vh;
}
.settings-nav {
  width: 140px;
  flex-shrink: 0;
  border-right: 1px solid #e8e8e8;
  padding: 8px 0;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  cursor: pointer;
  font-size: 13px;
  color: #555;
  transition: all 0.15s;
  border-left: 3px solid transparent;
}
.nav-item:hover {
  background: #f5f5f5;
}
.nav-item.active {
  background: rgba(24, 160, 88, 0.08);
  color: #18a058;
  border-left-color: #18a058;
  font-weight: 500;
}
.nav-icon {
  font-size: 14px;
}
.settings-content {
  flex: 1;
  min-width: 0;
  padding: 8px 24px;
  overflow: auto;
}
.category-pane {
  padding-bottom: 16px;
}
.pane-title {
  font-size: 15px;
  font-weight: 600;
  margin: 0 0 16px 0;
  color: #24292e;
}
.radio-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.radio-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 0;
}
.radio-label {
  font-size: 13px;
  font-weight: 500;
}
.radio-desc {
  font-size: 11px;
  margin-left: 22px;
  line-height: 1.4;
}
.form-hint {
  font-size: 11px;
  margin-left: 12px;
}
.dirty-hint {
  font-size: 11px;
  font-style: italic;
  margin-right: auto;
}
</style>
