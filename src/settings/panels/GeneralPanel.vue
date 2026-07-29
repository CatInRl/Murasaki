<script setup lang="ts">
/**
 * GeneralPanel — 常规设置面板
 *
 * 设置项：UI 模式、显示隐藏文件、显示 Agent 面板、默认图片目录
 * Design ref: settings-general.html
 */
import { computed } from "vue";
import type { SettingsState } from "../../types";

const props = defineProps<{ modelValue: SettingsState }>();
const emit = defineEmits<{ "update:modelValue": [SettingsState] }>();

const draft = computed(() => props.modelValue);

function patch<K extends keyof SettingsState>(key: K, value: SettingsState[K]): void {
  emit("update:modelValue", { ...draft.value, [key]: value });
}
</script>

<template>
  <div>
    <h1 class="settings-page-title">常规</h1>

    <!-- 外观 -->
    <section class="settings-section">
      <h2 class="settings-section-title">外观</h2>
      <div class="setting-row">
        <div class="setting-label-column">
          <span class="setting-label">界面模式</span>
          <span class="setting-description">选择 Murasaki 的界面显示模式</span>
        </div>
        <div class="setting-control-column">
          <div class="segmented-control" role="group" aria-label="界面模式">
            <button
              v-for="opt in [
                { v: 'light', l: '浅色' },
                { v: 'dark', l: '深色' },
                { v: 'system', l: '跟随系统' },
              ]"
              :key="opt.v"
              type="button"
              class="segmented-item"
              :class="{ active: draft.uiMode === opt.v }"
              @click="patch('uiMode', opt.v as SettingsState['uiMode'])"
            >
              {{ opt.l }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- 文件处理 -->
    <section class="settings-section">
      <h2 class="settings-section-title">文件处理</h2>
      <div class="setting-row">
        <div class="setting-label-column">
          <span class="setting-label">显示隐藏文件</span>
          <span class="setting-description">在文件树中显示以 <code>.</code> 开头的文件和目录</span>
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
          <span class="setting-label">默认图片目录</span>
          <span class="setting-description">粘贴或拖入图片时默认保存到的相对目录</span>
        </div>
        <div class="setting-control-column">
          <input
            class="setting-input"
            type="text"
            :value="draft.defaultImageDir"
            placeholder="例如：assets/images"
            @input="patch('defaultImageDir', ($event.target as HTMLInputElement).value)"
          />
        </div>
      </div>
    </section>

    <!-- Agent -->
    <section class="settings-section">
      <h2 class="settings-section-title">Agent</h2>
      <div class="setting-row">
        <div class="setting-label-column">
          <span class="setting-label">显示 Agent 面板</span>
          <span class="setting-description">在编辑器右侧显示 AI Agent 面板（仅 source/split 模式可用）</span>
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
  </div>
</template>
