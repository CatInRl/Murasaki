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
  NInput,
  NSelect,
  NSpin,
} from "naive-ui";
import { usePersistenceStore } from "../stores/usePersistenceStore";
import { useAiProvidersStore } from "../stores/useAiProvidersStore";
import { MARKDOWN_THEMES } from "../composables/useTheme";
import type { SettingsState, AiProvider, AiProviderPreset } from "../types";
import { AI_PROVIDER_PRESETS } from "../types";

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
const aiProviders = useAiProvidersStore();

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
      // 加载 AI providers（若尚未加载）
      if (!aiProviders.loaded) {
        aiProviders.load();
      }
    }
  }
);

// ===== 分类导航 =====
type Category = "appearance" | "editor" | "files" | "ai";

const activeCategory = ref<Category>("appearance");

const categories: Array<{ key: Category; label: string; icon: string }> = [
  { key: "appearance", label: "外观", icon: "🎨" },
  { key: "editor", label: "编辑", icon: "✏️" },
  { key: "files", label: "文件", icon: "📁" },
  { key: "ai", label: "AI", icon: "🤖" },
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
    a.sidebarView !== b.sidebarView ||
    a.showAgentPanel !== b.showAgentPanel
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

async function onShowAgentPanelChange(value: boolean): Promise<void> {
  await applyField("showAgentPanel", value);
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

// ===== AI Provider 管理 =====
/** 当前选中的 provider id（用于左侧列表高亮 + 右侧编辑） */
const selectedProviderId = ref<string | null>(null);
/** 编辑中的 provider 副本 */
const editingProvider = ref<AiProvider | null>(null);
/** 编辑中的 API key（明文，仅在保存时传给后端） */
const editingApiKey = ref<string>("");
/** API key 显示切换 */
const showApiKey = ref<boolean>(false);
/** 保存中状态 */
const savingProvider = ref<boolean>(false);
/** 错误信息 */
const providerError = ref<string>("");

/** 选中某个 provider 进行编辑 */
function selectProvider(id: string): void {
  const p = aiProviders.providers.find((p) => p.id === id);
  if (!p) return;
  selectedProviderId.value = id;
  editingProvider.value = { ...p };
  editingApiKey.value = ""; // 编辑时不显示原 key，用户输入新 key 才更新
  showApiKey.value = false;
  providerError.value = "";
  aiProviders.resetTestStatus();
}

/** 新建 provider（基于预设） */
function newProvider(preset?: AiProviderPreset): void {
  const p = preset ?? AI_PROVIDER_PRESETS[0];
  editingProvider.value = {
    id: "",
    name: p.label,
    type: p.type,
    baseUrl: p.baseUrl,
    model: p.model,
    isActive: aiProviders.providers.length === 0, // 首个自动设为活动
  };
  selectedProviderId.value = null;
  editingApiKey.value = "";
  showApiKey.value = false;
  providerError.value = "";
  aiProviders.resetTestStatus();
}

/** 保存当前编辑的 provider */
async function saveCurrentProvider(): Promise<void> {
  if (!editingProvider.value) return;
  if (!editingProvider.value.name.trim()) {
    providerError.value = "名称不能为空";
    return;
  }
  if (!editingProvider.value.baseUrl.trim()) {
    providerError.value = "URL 不能为空";
    return;
  }
  if (!editingProvider.value.model.trim()) {
    providerError.value = "Model 不能为空";
    return;
  }
  // 新增时必须填 API key
  const isNew = !editingProvider.value.id;
  if (isNew && !editingApiKey.value.trim()) {
    providerError.value = "新增 provider 必须填写 API key";
    return;
  }
  savingProvider.value = true;
  providerError.value = "";
  try {
    const saved = await aiProviders.saveProvider(
      editingProvider.value,
      editingApiKey.value
    );
    selectedProviderId.value = saved.id;
    editingProvider.value = { ...saved };
    editingApiKey.value = ""; // 清空明文
  } catch (err) {
    providerError.value = String(err);
  } finally {
    savingProvider.value = false;
  }
}

/** 删除当前选中的 provider */
async function deleteCurrentProvider(): Promise<void> {
  if (!selectedProviderId.value) return;
  try {
    await aiProviders.deleteProvider(selectedProviderId.value);
    editingProvider.value = null;
    selectedProviderId.value = null;
    editingApiKey.value = "";
  } catch (err) {
    providerError.value = String(err);
  }
}

/** 设为活动 provider */
async function makeActive(): Promise<void> {
  if (!editingProvider.value || !editingProvider.value.id) return;
  try {
    await aiProviders.setActive(editingProvider.value.id);
    editingProvider.value = { ...editingProvider.value, isActive: true };
  } catch (err) {
    providerError.value = String(err);
  }
}

/** 测试连接 */
async function testCurrentProvider(): Promise<void> {
  if (!editingProvider.value) return;
  // 新增未保存时用编辑中的 key，已存在但 key 为空时提示需要先填 key
  let apiKey = editingApiKey.value;
  if (!apiKey && editingProvider.value.id) {
    // 已保存但未输入新 key，尝试从后端取
    try {
      apiKey = await aiProviders.getApiKey(editingProvider.value.id);
    } catch {
      providerError.value = "无法获取 API key，请重新输入";
      return;
    }
  }
  if (!apiKey) {
    providerError.value = "请先填写 API key";
    return;
  }
  try {
    await aiProviders.testConnection(
      editingProvider.value.baseUrl,
      apiKey,
      editingProvider.value.model
    );
  } catch (err) {
    providerError.value = String(err);
  }
}

/** Provider 类型选项 */
const providerTypeOptions = AI_PROVIDER_PRESETS.map((p) => ({
  label: p.label,
  value: p.type,
}));

/** 类型变更时自动填充预设 URL/Model（仅当字段为空或与旧预设一致时） */
function onProviderTypeChange(newType: AiProvider["type"]): void {
  if (!editingProvider.value) return;
  const preset = AI_PROVIDER_PRESETS.find((p) => p.type === newType);
  if (!preset) return;
  const oldPreset = AI_PROVIDER_PRESETS.find(
    (p) => p.type === editingProvider.value!.type
  );
  // 若当前 URL/Model 为空或等于旧预设，则更新为新预设
  if (
    !editingProvider.value.baseUrl ||
    editingProvider.value.baseUrl === oldPreset?.baseUrl
  ) {
    editingProvider.value.baseUrl = preset.baseUrl;
  }
  if (
    !editingProvider.value.model ||
    editingProvider.value.model === oldPreset?.model
  ) {
    editingProvider.value.model = preset.model;
  }
  editingProvider.value.type = newType;
}
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
            <NDivider />
            <NFormItem label="显示 Agent 面板">
              <NSwitch
                :value="draft.showAgentPanel"
                @update:value="(v: boolean) => onShowAgentPanelChange(v)"
              />
              <NTag
                v-if="isFieldDirty('showAgentPanel')"
                size="small"
                type="warning"
                style="margin-left: 12px"
              >
                已修改
              </NTag>
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

        <!-- AI -->
        <div v-else-if="activeCategory === 'ai'" class="category-pane ai-pane">
          <h3 class="pane-title">AI 服务配置</h3>

          <!-- 活动 provider 信息卡片（顶部显著展示） -->
          <div
            v-if="aiProviders.activeProvider"
            class="ai-active-card"
          >
            <div class="ai-active-label">当前活动 provider</div>
            <div class="ai-active-name">
              {{ aiProviders.activeProvider.name }}
              <NTag size="tiny" type="success" style="margin-left: 6px">
                {{ aiProviders.activeProvider.type }}
              </NTag>
            </div>
            <NText depth="3" class="ai-active-meta">
              {{ aiProviders.activeProvider.baseUrl }} · {{ aiProviders.activeProvider.model }}
            </NText>
          </div>
          <NAlert
            v-else
            type="warning"
            :show-icon="true"
            style="margin-bottom: 12px"
          >
            尚未设置活动 provider，请配置并设为活动后 agent 才能使用。
          </NAlert>

          <NAlert type="info" :show-icon="true" style="margin-bottom: 16px">
            API key 通过 Windows DPAPI 加密存储，仅在调用 LLM 时按需解密。
            支持配置多个 provider，选择一个为「活动」。
            BYOK（自带密钥）：请自行确保 provider 与密钥的合法性与安全性。
          </NAlert>

          <div class="ai-layout">
            <!-- 左侧 provider 列表 -->
            <div class="ai-list">
              <div class="ai-list-header">
                <NText depth="2" style="font-size: 12px; font-weight: 500">
                  Provider 列表
                </NText>
                <NButton
                  size="tiny"
                  type="primary"
                  ghost
                  @click="newProvider()"
                >
                  + 新增
                </NButton>
              </div>
              <div v-if="aiProviders.providers.length === 0" class="ai-list-empty">
                <NText depth="3" style="font-size: 12px">
                  暂无 provider，点击「新增」配置
                </NText>
              </div>
              <div
                v-for="p in aiProviders.providers"
                :key="p.id"
                class="ai-list-item"
                :class="{ active: selectedProviderId === p.id }"
                @click="selectProvider(p.id)"
              >
                <div class="ai-list-item-name">
                  {{ p.name }}
                  <NTag
                    v-if="p.isActive"
                    size="tiny"
                    type="success"
                    style="margin-left: 4px"
                  >
                    活动
                  </NTag>
                </div>
                <NText depth="3" class="ai-list-item-url">
                  {{ p.baseUrl }}
                </NText>
              </div>
            </div>

            <!-- 右侧编辑区 -->
            <div class="ai-editor">
              <div v-if="!editingProvider" class="ai-editor-empty">
                <NText depth="3">
                  选择左侧 provider 编辑，或点击「新增」配置
                </NText>
              </div>
              <NSpin v-else :show="savingProvider">
                <NForm label-placement="top">
                  <NFormItem label="类型">
                    <NSelect
                      :value="editingProvider.type"
                      :options="providerTypeOptions"
                      @update:value="onProviderTypeChange"
                    />
                  </NFormItem>
                  <NFormItem label="名称">
                    <NInput
                      v-model:value="editingProvider.name"
                      placeholder="如 DeepSeek 主力"
                    />
                  </NFormItem>
                  <NFormItem label="Base URL">
                    <NInput
                      v-model:value="editingProvider.baseUrl"
                      placeholder="https://api.deepseek.com"
                    />
                  </NFormItem>
                  <NFormItem label="Model">
                    <NInput
                      v-model:value="editingProvider.model"
                      placeholder="deepseek-v4-flash"
                    />
                  </NFormItem>
                  <NFormItem label="API Key">
                    <NInput
                      v-model:value="editingApiKey"
                      :type="showApiKey ? 'text' : 'password'"
                      placeholder="新增时必填，编辑时留空表示保留原 key"
                    />
                    <NButton
                      size="small"
                      quaternary
                      style="margin-left: 8px"
                      @click="showApiKey = !showApiKey"
                    >
                      {{ showApiKey ? "隐藏" : "显示" }}
                    </NButton>
                  </NFormItem>

                  <NSpace>
                    <NButton
                      type="primary"
                      :loading="savingProvider"
                      @click="saveCurrentProvider"
                    >
                      保存
                    </NButton>
                    <NButton
                      v-if="editingProvider.id && !editingProvider.isActive"
                      @click="makeActive"
                    >
                      设为活动
                    </NButton>
                    <NButton
                      :loading="aiProviders.testStatus === 'testing'"
                      @click="testCurrentProvider"
                    >
                      测试连接
                    </NButton>
                    <NButton
                      v-if="selectedProviderId"
                      quaternary
                      type="error"
                      @click="deleteCurrentProvider"
                    >
                      删除
                    </NButton>
                  </NSpace>

                  <!-- 测试连接结果 -->
                  <NAlert
                    v-if="aiProviders.testStatus === 'success'"
                    type="success"
                    :show-icon="true"
                    style="margin-top: 12px"
                  >
                    {{ aiProviders.testMessage }}
                    <div
                      v-if="aiProviders.testModels.length > 0"
                      class="ai-models-list"
                    >
                      <NText depth="3" style="font-size: 11px">可用模型：</NText>
                      <NTag
                        v-for="m in aiProviders.testModels.slice(0, 10)"
                        :key="m"
                        size="tiny"
                        style="margin: 2px"
                      >
                        {{ m }}
                      </NTag>
                      <NText
                        v-if="aiProviders.testModels.length > 10"
                        depth="3"
                        style="font-size: 11px"
                      >
                        ...等 {{ aiProviders.testModels.length }} 个
                      </NText>
                    </div>
                  </NAlert>
                  <NAlert
                    v-if="aiProviders.testStatus === 'error'"
                    type="error"
                    :show-icon="true"
                    style="margin-top: 12px"
                  >
                    {{ aiProviders.testMessage }}
                  </NAlert>

                  <!-- 错误信息 -->
                  <NAlert
                    v-if="providerError"
                    type="error"
                    :show-icon="true"
                    style="margin-top: 12px"
                  >
                    {{ providerError }}
                  </NAlert>
                </NForm>
              </NSpin>
            </div>
          </div>
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

/* AI 分类面板 */
.ai-pane .ai-layout {
  display: flex;
  gap: 16px;
  min-height: 320px;
}
.ai-pane .ai-list {
  width: 200px;
  flex-shrink: 0;
  border: 1px solid #e8e8e8;
  border-radius: 4px;
  overflow: auto;
  max-height: 50vh;
}
.ai-pane .ai-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid #f0f0f0;
  position: sticky;
  top: 0;
  background: #fff;
  z-index: 1;
}
.ai-pane .ai-list-empty {
  padding: 16px 10px;
  text-align: center;
}
.ai-pane .ai-list-item {
  padding: 8px 10px;
  cursor: pointer;
  border-bottom: 1px solid #f5f5f5;
  transition: background 0.15s;
}
.ai-pane .ai-list-item:hover {
  background: #f9f9f9;
}
.ai-pane .ai-list-item.active {
  background: rgba(24, 160, 88, 0.08);
}
.ai-pane .ai-list-item-name {
  font-size: 13px;
  font-weight: 500;
  color: #24292e;
  display: flex;
  align-items: center;
}
.ai-pane .ai-list-item-url {
  font-size: 11px;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
}
.ai-pane .ai-editor {
  flex: 1;
  min-width: 0;
}
.ai-pane .ai-editor-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 200px;
  border: 1px dashed #e8e8e8;
  border-radius: 4px;
}
.ai-pane .ai-models-list {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
}
.ai-active-card {
  padding: 10px 14px;
  margin-bottom: 12px;
  border: 1px solid #d4edda;
  border-radius: 4px;
  background: rgba(24, 160, 88, 0.06);
}
.ai-active-label {
  font-size: 11px;
  color: #18a058;
  font-weight: 500;
  margin-bottom: 4px;
}
.ai-active-name {
  font-size: 14px;
  font-weight: 600;
  color: #24292e;
  display: flex;
  align-items: center;
}
.ai-active-meta {
  font-size: 12px;
  margin-top: 2px;
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
