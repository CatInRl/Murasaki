<script setup lang="ts">
/**
 * AiPanel — AI 设置面板
 *
 * 设置项：Provider 列表、Provider 编辑表单、默认 Provider 选择
 * Design ref: settings-ai.html
 *
 * 本面板直接使用 useAiProvidersStore（Provider 有独立的持久化逻辑）。
 * API Key 不在前端持久化，仅通过 get_api_key 按需获取（本面板不预填）。
 *
 * T8.2 范围：表单显示与编辑（保存即生效）。
 * T8.4：测试连接（testProvider + localStorage 状态指示器）、删除二次确认。
 * T8.5：高级参数可编辑（存 SettingsState，所有 provider 共用）。
 * ADR-0011: 支持 OpenAI 兼容 + Anthropic 双协议（createProvider 工厂按 type 路由）。
 */
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Plus, Trash2, Plug, ChevronDown, Eye, EyeOff, Check, X } from "lucide-vue-next";
import { useAiProvidersStore, type TestConnectionResult } from "../../stores/useAiProvidersStore";
import { usePersistenceStore } from "../../stores/usePersistenceStore";
import { useDialogStore } from "../../stores/useDialogStore";
import DialogContainer from "../../components/DialogContainer.vue";
import { AI_PROVIDER_PRESETS, type AiProvider } from "../../types";

const store = useAiProvidersStore();
const persistence = usePersistenceStore();
const dialog = useDialogStore();
const { t } = useI18n();

/** 当前选中编辑的 provider id */
const selectedId = ref<string | null>(null);

/** 表单编辑副本（与 store 解耦，保存时写回） */
const form = ref({
  name: "",
  type: "custom" as AiProvider["type"],
  baseUrl: "",
  model: "",
  apiKey: "",
});

/** API Key 显示/隐藏 */
const showApiKey = ref(false);

/** 测试状态 */
const testStatus = ref<"idle" | "testing" | "success" | "error">("idle");
const testMessage = ref("");

/** 上次测试结果（从 localStorage 读取，切换 provider 时刷新） */
const lastTestResult = ref<TestConnectionResult | null>(null);

const selectedProvider = computed<AiProvider | null>(() =>
  store.providers.find((p) => p.id === selectedId.value) ?? null
);

/** 高级参数（存 SettingsState，所有 provider 共用，T8.5） */
const aiAgentMaxRounds = computed({
  get: () => persistence.settings.aiAgentMaxRounds,
  set: (v: number) => {
    if (Number.isFinite(v)) void persistence.updateSettings({ aiAgentMaxRounds: v });
  },
});
const aiSingleRequestTokenLimit = computed({
  get: () => persistence.settings.aiSingleRequestTokenLimit,
  set: (v: number) => {
    if (Number.isFinite(v)) void persistence.updateSettings({ aiSingleRequestTokenLimit: v });
  },
});
const aiCumulativeTokenSoftLimit = computed({
  get: () => persistence.settings.aiCumulativeTokenSoftLimit,
  set: (v: number) => {
    if (Number.isFinite(v)) void persistence.updateSettings({ aiCumulativeTokenSoftLimit: v });
  },
});
const aiProposeReplaceConfirmThreshold = computed({
  get: () => persistence.settings.aiProposeReplaceConfirmThreshold,
  set: (v: number) => {
    if (Number.isFinite(v)) void persistence.updateSettings({ aiProposeReplaceConfirmThreshold: v });
  },
});

/** 状态指示器显示状态：优先当前测试状态，idle 时回退到 localStorage 上次结果 */
const displayStatus = computed<"idle" | "testing" | "success" | "error">(() => {
  if (testStatus.value === "testing") return "testing";
  if (testStatus.value === "success" || testStatus.value === "error") return testStatus.value;
  if (lastTestResult.value) {
    return lastTestResult.value.success ? "success" : "error";
  }
  return "idle";
});

const displayMessage = computed(() => {
  if (testStatus.value === "testing") return t("settings.ai.testing");
  if (testStatus.value === "success" || testStatus.value === "error") return testMessage.value;
  if (lastTestResult.value) {
    return lastTestResult.value.message ?? (lastTestResult.value.success ? t("settings.ai.connectSuccess") : t("settings.ai.connectFailed"));
  }
  return "";
});

/** 初始化：选中第一个 provider 或活动 provider */
function initSelection(): void {
  if (store.providers.length === 0) return;
  const active = store.providers.find((p) => p.isActive);
  selectedId.value = active?.id ?? store.providers[0].id;
}

watch(
  () => store.providers,
  () => {
    if (!selectedId.value || !store.providers.find((p) => p.id === selectedId.value)) {
      initSelection();
    }
    syncForm();
  },
  { deep: true, immediate: true }
);

watch(selectedId, syncForm);

function syncForm(): void {
  const p = selectedProvider.value;
  if (!p) {
    form.value = { name: "", type: "custom", baseUrl: "", model: "", apiKey: "" };
    lastTestResult.value = null;
    return;
  }
  form.value = {
    name: p.name,
    type: p.type,
    baseUrl: p.baseUrl,
    model: p.model,
    apiKey: "", // 不预填，安全考虑
  };
  showApiKey.value = false;
  testStatus.value = "idle";
  testMessage.value = "";
  // 从 localStorage 读取上次测试结果
  lastTestResult.value = store.getTestResult(p.id);
}

function selectProvider(id: string): void {
  selectedId.value = id;
}

async function setDefault(id: string): Promise<void> {
  await store.setActive(id);
}

async function handleAddProvider(): Promise<void> {
  const preset = AI_PROVIDER_PRESETS[0];
  const newProvider: AiProvider = {
    id: "",
    name: preset.label,
    type: preset.type,
    baseUrl: preset.baseUrl,
    model: preset.model,
    isActive: store.providers.length === 0,
  };
  const saved = await store.saveProvider(newProvider, "");
  selectedId.value = saved.id;
}

async function handleDeleteProvider(): Promise<void> {
  const provider = selectedProvider.value;
  if (!provider) return;
  const confirmed = await dialog.confirm({
    title: t("settings.ai.deleteProviderTitle"),
    message: t("settings.ai.deleteProviderMessage", { name: provider.name }),
    danger: true,
    confirmText: t("settings.ai.deleteConfirm"),
  });
  if (!confirmed) return;
  await store.deleteProvider(provider.id);
  lastTestResult.value = null;
  initSelection();
}

async function handleSaveProvider(): Promise<void> {
  if (!selectedProvider.value) return;
  await store.saveProvider(
    {
      ...selectedProvider.value,
      name: form.value.name,
      type: form.value.type,
      baseUrl: form.value.baseUrl,
      model: form.value.model,
    },
    form.value.apiKey
  );
  form.value.apiKey = "";
}

async function handleTestConnection(): Promise<void> {
  if (!selectedProvider.value) return;
  testStatus.value = "testing";
  testMessage.value = t("settings.ai.testing");
  try {
    const result = await store.testProvider(selectedProvider.value.id);
    testStatus.value = result.success ? "success" : "error";
    testMessage.value = result.message ?? (result.success ? t("settings.ai.connectSuccess") : t("settings.ai.connectFailed"));
    lastTestResult.value = result;
  } catch {
    // testProvider 不抛出异常，此处为防御性处理
    testStatus.value = "error";
    testMessage.value = t("settings.ai.testFailed");
  }
}

function typeLabel(type: AiProvider["type"]): string {
  const preset = AI_PROVIDER_PRESETS.find((p) => p.type === type);
  return preset?.label ?? t("settings.ai.customType");
}
</script>

<template>
  <div>
    <h1 class="settings-page-title">AI</h1>

    <!-- Provider 管理 -->
    <section class="settings-section">
      <h2 class="settings-section-title">{{ $t('settings.ai.providerManagement') }}</h2>

      <div class="provider-workspace">
        <!-- Provider List -->
        <aside class="provider-list">
          <div class="provider-list-header">
            <span>{{ $t('settings.ai.providersHeader') }}</span>
          </div>
          <div class="provider-items" role="radiogroup" :aria-label="$t('settings.ai.providerListAria')">
            <label
              v-for="p in store.providers"
              :key="p.id"
              class="provider-item"
              :class="{ selected: selectedId === p.id }"
            >
              <input
                type="radio"
                name="default-provider"
                class="provider-radio"
                :checked="p.isActive"
                @change="setDefault(p.id)"
              />
              <div class="provider-item-body" @click="selectProvider(p.id)">
                <div class="provider-item-main">
                  <span class="provider-name">{{ p.name }}</span>
                  <span v-if="p.isActive" class="provider-badge">{{ $t('settings.ai.defaultBadge') }}</span>
                </div>
                <div class="provider-item-meta">{{ typeLabel(p.type) }}</div>
              </div>
            </label>
          </div>
          <div class="provider-list-footer">
            <button class="provider-add-btn" type="button" @click="handleAddProvider">
              <Plus :size="14" />
              <span>{{ $t('settings.ai.addProvider') }}</span>
            </button>
          </div>
        </aside>

        <!-- Provider Editor -->
        <div v-if="selectedProvider" class="provider-editor">
          <div class="provider-editor-header">
            <h3 class="provider-editor-title">{{ $t('settings.ai.apiSettings') }}</h3>
            <button
              class="provider-delete-btn"
              type="button"
              :aria-label="$t('settings.ai.deleteProviderAria')"
              @click="handleDeleteProvider"
            >
              <Trash2 :size="15" />
            </button>
          </div>

          <form class="provider-form" @submit.prevent="handleSaveProvider">
            <div class="setting-row provider-form-row">
              <div class="setting-label-column">
                <label class="setting-label">{{ $t('settings.ai.nameLabel') }}</label>
                <span class="setting-description">{{ $t('settings.ai.nameDesc') }}</span>
              </div>
              <div class="setting-control-column">
                <input
                  v-model="form.name"
                  class="setting-input"
                  type="text"
                  :placeholder="$t('settings.ai.namePlaceholder')"
                />
              </div>
            </div>

            <div class="setting-row provider-form-row">
              <div class="setting-label-column">
                <label class="setting-label">{{ $t('settings.ai.typeLabel') }}</label>
                <span class="setting-description">{{ $t('settings.ai.typeDesc') }}</span>
              </div>
              <div class="setting-control-column">
                <div class="select-wrapper">
                  <select v-model="form.type">
                    <option v-for="preset in AI_PROVIDER_PRESETS" :key="preset.type" :value="preset.type">
                      {{ preset.label }}
                    </option>
                  </select>
                  <svg class="select-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </div>
              </div>
            </div>

            <div class="setting-row provider-form-row">
              <div class="setting-label-column">
                <label class="setting-label">{{ $t('settings.ai.apiUrlLabel') }}</label>
                <span class="setting-description">{{ $t('settings.ai.apiUrlDesc') }}</span>
              </div>
              <div class="setting-control-column">
                <input
                  v-model="form.baseUrl"
                  class="setting-input wide-input"
                  type="text"
                  placeholder="https://api.deepseek.com"
                />
              </div>
            </div>

            <div class="setting-row provider-form-row">
              <div class="setting-label-column">
                <label class="setting-label">{{ $t('settings.ai.modelLabel') }}</label>
                <span class="setting-description">{{ $t('settings.ai.modelDesc') }}</span>
              </div>
              <div class="setting-control-column">
                <input
                  v-model="form.model"
                  class="setting-input"
                  type="text"
                  placeholder="deepseek-v4-flash"
                />
              </div>
            </div>

            <div class="setting-row provider-form-row">
              <div class="setting-label-column">
                <label class="setting-label">{{ $t('settings.ai.apiKeyLabel') }}</label>
                <span class="setting-description">{{ $t('settings.ai.apiKeyDesc') }}</span>
              </div>
              <div class="setting-control-column">
                <div class="password-input-wrap">
                  <input
                    v-model="form.apiKey"
                    class="setting-input password-input"
                    :type="showApiKey ? 'text' : 'password'"
                    :placeholder="$t('settings.ai.apiKeyPlaceholder')"
                  />
                  <button
                    type="button"
                    class="password-toggle"
                    :aria-label="showApiKey ? $t('settings.ai.hideApiKeyAria') : $t('settings.ai.showApiKeyAria')"
                    @click="showApiKey = !showApiKey"
                  >
                    <Eye v-if="!showApiKey" :size="14" />
                    <EyeOff v-else :size="14" />
                  </button>
                </div>
              </div>
            </div>

            <div class="provider-form-actions">
              <button type="button" class="secondary-button" @click="handleTestConnection">
                <Plug :size="14" />
                {{ $t('settings.ai.testConnection') }}
              </button>
              <button type="submit" class="primary-button">{{ $t('settings.ai.saveProvider') }}</button>
              <div v-if="displayStatus !== 'idle'" class="provider-status">
                <Check
                  v-if="displayStatus === 'success'"
                  :size="14"
                  class="status-icon success"
                />
                <X
                  v-else-if="displayStatus === 'error'"
                  :size="14"
                  class="status-icon error"
                />
                <span
                  v-else
                  class="provider-status-dot testing"
                ></span>
                <span class="provider-status-text">{{ displayMessage }}</span>
              </div>
            </div>
          </form>
        </div>

        <!-- Empty state -->
        <div v-else class="provider-editor-empty">
          <p>{{ $t('settings.ai.emptyEditorHint') }}</p>
        </div>
      </div>
    </section>

    <!-- 高级参数（可编辑，存 SettingsState，T8.5） -->
    <section class="settings-section">
      <details class="advanced-params">
        <summary class="advanced-params-summary">
          <ChevronDown :size="16" class="advanced-params-chevron" />
          <span class="advanced-params-title">{{ $t('settings.ai.advancedParams') }}</span>
          <span class="advanced-params-hint">{{ $t('settings.ai.advancedParamsHint') }}</span>
        </summary>
        <div class="advanced-params-body">
          <div class="setting-row">
            <div class="setting-label-column">
              <label class="setting-label">{{ $t('settings.ai.agentMaxRounds') }}</label>
              <span class="setting-description">{{ $t('settings.ai.agentMaxRoundsDesc') }}</span>
            </div>
            <div class="setting-control-column">
              <input
                v-model.number="aiAgentMaxRounds"
                class="setting-input number-input"
                type="number"
                min="1"
                max="50"
              />
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-label-column">
              <label class="setting-label">{{ $t('settings.ai.singleRequestTokenLimit') }}</label>
              <span class="setting-description">{{ $t('settings.ai.singleRequestTokenLimitDesc') }}</span>
            </div>
            <div class="setting-control-column">
              <input
                v-model.number="aiSingleRequestTokenLimit"
                class="setting-input number-input"
                type="number"
                min="1024"
                step="1024"
              />
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-label-column">
              <label class="setting-label">{{ $t('settings.ai.cumulativeTokenSoftLimit') }}</label>
              <span class="setting-description">{{ $t('settings.ai.cumulativeTokenSoftLimitDesc') }}</span>
            </div>
            <div class="setting-control-column">
              <input
                v-model.number="aiCumulativeTokenSoftLimit"
                class="setting-input number-input"
                type="number"
                min="1024"
                step="1024"
              />
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-label-column">
              <label class="setting-label">{{ $t('settings.ai.proposeReplaceConfirmThreshold') }}</label>
              <span class="setting-description">{{ $t('settings.ai.proposeReplaceConfirmThresholdDesc') }}</span>
            </div>
            <div class="setting-control-column">
              <input
                v-model.number="aiProposeReplaceConfirmThreshold"
                class="setting-input number-input"
                type="number"
                min="1"
              />
            </div>
          </div>
        </div>
      </details>
    </section>

    <!-- 对话框容器（设置窗口独立挂载，用于删除二次确认） -->
    <DialogContainer />
  </div>
</template>

<style scoped>
/* === Provider Workspace === */
.provider-workspace {
  display: flex;
  gap: 0;
  border: 1px solid var(--murasaki-line);
  border-radius: var(--murasaki-radius-lg);
  overflow: hidden;
  background: var(--murasaki-background);
  min-height: 360px;
}

/* === Provider List === */
.provider-list {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--murasaki-surface);
  border-right: 1px solid var(--murasaki-line);
  overflow: hidden;
}
.provider-list-header {
  padding: 14px 14px 8px;
  font-size: var(--murasaki-text-xs);
  font-weight: 600;
  color: var(--murasaki-ink-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  user-select: none;
}
.provider-items {
  flex: 1;
  overflow-y: auto;
  padding: 0 10px 8px;
}
.provider-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--murasaki-radius-md);
  cursor: pointer;
  transition: background 120ms;
  user-select: none;
}
.provider-item:hover {
  background: var(--murasaki-neutral-200);
}
.provider-item.selected {
  background: var(--murasaki-purple-50);
}
.provider-item.selected .provider-name {
  color: var(--murasaki-primary);
  font-weight: 500;
}
.provider-radio {
  margin: 2px 0 0 0;
  accent-color: var(--murasaki-primary);
  flex-shrink: 0;
}
.provider-item-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.provider-item-main {
  display: flex;
  align-items: center;
  gap: 6px;
}
.provider-name {
  font-size: var(--murasaki-text-sm);
  color: var(--murasaki-ink);
}
.provider-badge {
  padding: 1px 5px;
  border-radius: var(--murasaki-radius-sm);
  background: var(--murasaki-purple-100);
  color: var(--murasaki-purple-700);
  font-size: 11px;
  font-weight: 500;
}
.provider-item-meta {
  font-size: var(--murasaki-text-xs);
  color: var(--murasaki-ink-3);
}
.provider-list-footer {
  padding: 10px;
  border-top: 1px solid var(--murasaki-line);
}
.provider-add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  padding: 7px 10px;
  border: 1px dashed var(--murasaki-line);
  border-radius: var(--murasaki-radius-md);
  background: transparent;
  color: var(--murasaki-ink-2);
  font-size: var(--murasaki-text-sm);
  font-family: inherit;
  cursor: pointer;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.provider-add-btn:hover {
  background: var(--murasaki-neutral-100);
  border-color: var(--murasaki-purple-300);
  color: var(--murasaki-primary);
}

/* === Provider Editor === */
.provider-editor {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 20px 24px 24px;
  overflow-y: auto;
}
.provider-editor-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--murasaki-ink-3);
  font-size: var(--murasaki-text-sm);
}
.provider-editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.provider-editor-title {
  font-size: var(--murasaki-text-lg);
  font-weight: 600;
  color: var(--murasaki-ink);
  margin: 0;
}
.provider-delete-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--murasaki-radius-sm);
  background: transparent;
  color: var(--murasaki-ink-3);
  cursor: pointer;
  transition: background 120ms, color 120ms;
}
.provider-delete-btn:hover {
  background: var(--murasaki-state-error);
  color: #ffffff;
}
.provider-form {
  display: flex;
  flex-direction: column;
}
.provider-form-row {
  padding: 12px 0;
}
.provider-form-row:first-child {
  padding-top: 0;
}
.provider-form-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--murasaki-line);
}
.provider-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--murasaki-ink-2);
  font-size: var(--murasaki-text-xs);
}
.status-icon {
  flex-shrink: 0;
}
.status-icon.success {
  color: var(--murasaki-state-success);
}
.status-icon.error {
  color: var(--murasaki-state-error);
}
.provider-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--murasaki-neutral-400);
  flex-shrink: 0;
}
.provider-status-dot.testing {
  background: var(--murasaki-state-warning);
  animation: pulse 1s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* === Wide input for API URL === */
.wide-input {
  width: 280px;
}

/* === Password Input === */
.password-input-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.password-input-wrap .setting-input {
  padding-right: 32px;
  width: 200px;
}
.password-toggle {
  position: absolute;
  right: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--murasaki-radius-sm);
  background: transparent;
  color: var(--murasaki-ink-3);
  cursor: pointer;
}
.password-toggle:hover {
  color: var(--murasaki-ink);
}

/* === Advanced Params === */
.advanced-params {
  border: 1px solid var(--murasaki-line);
  border-radius: var(--murasaki-radius-md);
  overflow: hidden;
}
.advanced-params-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  cursor: pointer;
  user-select: none;
  background: var(--murasaki-surface);
  transition: background 120ms;
}
.advanced-params-summary:hover {
  background: var(--murasaki-neutral-100);
}
.advanced-params-chevron {
  transition: transform 120ms;
  color: var(--murasaki-ink-3);
  flex-shrink: 0;
}
.advanced-params[open] .advanced-params-chevron {
  transform: rotate(180deg);
}
.advanced-params-title {
  font-size: var(--murasaki-text-sm);
  font-weight: 600;
  color: var(--murasaki-ink);
}
.advanced-params-hint {
  font-size: var(--murasaki-text-xs);
  color: var(--murasaki-ink-3);
}
.advanced-params-body {
  padding: 0 16px 8px;
  background: var(--murasaki-background);
}
.number-input {
  width: 120px;
}
</style>
