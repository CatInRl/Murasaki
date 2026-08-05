<script setup lang="ts">
/**
 * GeneralPanel — 常规设置面板
 *
 * 设置项：UI 模式、界面语言、显示隐藏文件、显示 Agent 面板、默认图片目录
 * Design ref: settings-general.html
 */
import { computed } from "vue";
import type { SettingsState, AppLocale } from "../../types";

const props = defineProps<{ modelValue: SettingsState }>();
const emit = defineEmits<{ "update:modelValue": [SettingsState] }>();

const draft = computed(() => props.modelValue);

function patch<K extends keyof SettingsState>(key: K, value: SettingsState[K]): void {
  emit("update:modelValue", { ...draft.value, [key]: value });
}
</script>

<template>
  <div>
    <h1 class="settings-page-title">{{ $t('settings.general.title') }}</h1>

    <!-- 外观 -->
    <section class="settings-section">
      <h2 class="settings-section-title">{{ $t('settings.general.appearance') }}</h2>

      <!-- 界面语言（ADR-0013） -->
      <div class="setting-row">
        <div class="setting-label-column">
          <span class="setting-label">{{ $t('settings.general.language') }}</span>
          <span class="setting-description">{{ $t('settings.general.languageDesc') }}</span>
        </div>
        <div class="setting-control-column">
          <div class="select-wrapper">
            <select
              :value="draft.language"
              @change="patch('language', ($event.target as HTMLSelectElement).value as AppLocale)"
            >
              <option value="zh-CN">{{ $t('settings.general.languageZhCN') }}</option>
              <option value="en">{{ $t('settings.general.languageEn') }}</option>
            </select>
            <svg class="select-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </div>
        </div>
      </div>
    </section>

    <!-- 文件处理 -->
    <section class="settings-section">
      <h2 class="settings-section-title">{{ $t('settings.general.fileHandling') }}</h2>
      <div class="setting-row">
        <div class="setting-label-column">
          <span class="setting-label">{{ $t('settings.general.showHiddenFiles') }}</span>
          <span class="setting-description">{{ $t('settings.general.showHiddenFilesDesc') }}</span>
        </div>
        <div class="setting-control-column">
          <label class="toggle-switch">
            <input
              type="checkbox"
              :checked="draft.showHiddenFiles"
              @change="patch('showHiddenFiles', ($event.target as HTMLInputElement).checked)"
            />
            <span class="toggle-track" aria-hidden="true"></span>
          </label>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-label-column">
          <span class="setting-label">{{ $t('settings.general.defaultImageDir') }}</span>
          <span class="setting-description">{{ $t('settings.general.defaultImageDirDesc') }}</span>
        </div>
        <div class="setting-control-column">
          <input
            class="setting-input"
            type="text"
            :value="draft.defaultImageDir"
            :placeholder="$t('settings.general.defaultImageDirPlaceholder')"
            @input="patch('defaultImageDir', ($event.target as HTMLInputElement).value)"
          />
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-label-column">
          <span class="setting-label">{{ $t('settings.general.reopenLastWorkspace') }}</span>
          <span class="setting-description">{{ $t('settings.general.reopenLastWorkspaceDesc') }}</span>
        </div>
        <div class="setting-control-column">
          <label class="toggle-switch">
            <input
              type="checkbox"
              :checked="draft.reopenLastWorkspace"
              @change="patch('reopenLastWorkspace', ($event.target as HTMLInputElement).checked)"
            />
            <span class="toggle-track" aria-hidden="true"></span>
          </label>
        </div>
      </div>
    </section>

    <!-- Agent -->
    <section class="settings-section">
      <h2 class="settings-section-title">{{ $t('settings.general.agent') }}</h2>
      <div class="setting-row">
        <div class="setting-label-column">
          <span class="setting-label">{{ $t('settings.general.showAgentPanel') }}</span>
          <span class="setting-description">{{ $t('settings.general.showAgentPanelDesc') }}</span>
        </div>
        <div class="setting-control-column">
          <label class="toggle-switch">
            <input
              type="checkbox"
              :checked="draft.showAgentPanel"
              @change="patch('showAgentPanel', ($event.target as HTMLInputElement).checked)"
            />
            <span class="toggle-track" aria-hidden="true"></span>
          </label>
        </div>
      </div>
    </section>

    <!-- 更新 -->
    <section class="settings-section">
      <h2 class="settings-section-title">{{ $t('settings.general.updates') }}</h2>
      <div class="setting-row">
        <div class="setting-label-column">
          <span class="setting-label">{{ $t('settings.general.checkUpdatesOnStartup') }}</span>
          <span class="setting-description">{{ $t('settings.general.checkUpdatesOnStartupDesc') }}</span>
        </div>
        <div class="setting-control-column">
          <label class="toggle-switch">
            <input
              type="checkbox"
              :checked="draft.checkUpdatesOnStartup"
              @change="patch('checkUpdatesOnStartup', ($event.target as HTMLInputElement).checked)"
            />
            <span class="toggle-track" aria-hidden="true"></span>
          </label>
        </div>
      </div>
    </section>
  </div>
</template>
