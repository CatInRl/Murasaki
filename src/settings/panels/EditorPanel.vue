<script setup lang="ts">
/**
 * EditorPanel — 编辑器设置面板
 *
 * 设置项：编辑模式、字体大小、行高、字体族、显示行号、软折行
 * Design ref: settings-editor.html
 *
 * Mermaid/KaTeX/任务列表渲染默认开启，不暴露设置项（spec 决策）。
 */
import { computed } from "vue";
import type { SettingsState } from "../../types";

const props = defineProps<{ modelValue: SettingsState }>();
const emit = defineEmits<{ "update:modelValue": [SettingsState] }>();

const draft = computed(() => props.modelValue);

function patch<K extends keyof SettingsState>(key: K, value: SettingsState[K]): void {
  emit("update:modelValue", { ...draft.value, [key]: value });
}

const FONT_FAMILIES = ["JetBrains Mono", "Fira Code", "Cascadia Code", "Consolas"];
const LINE_HEIGHTS = [1.4, 1.6, 1.8, 2.0];

function stepFontSize(delta: number): void {
  const next = Math.min(20, Math.max(12, draft.value.editorFontSize + delta));
  patch("editorFontSize", next);
}
</script>

<template>
  <div>
    <h1 class="settings-page-title">编辑器</h1>

    <!-- 编辑模式 -->
    <section class="settings-section">
      <h2 class="settings-section-title">编辑模式</h2>
      <div class="setting-row">
        <div class="setting-label-column">
          <span class="setting-label">默认编辑模式</span>
          <span class="setting-description">新建或打开文件时使用的默认视图</span>
        </div>
        <div class="setting-control-column">
          <div class="segmented-control" role="radiogroup" aria-label="默认编辑模式">
            <button
              v-for="opt in [
                { v: 'source', l: '源码' },
                { v: 'split', l: '分屏' },
                { v: 'wysiwyg', l: '所见即所得' },
              ]"
              :key="opt.v"
              type="button"
              class="segmented-item"
              :class="{ active: draft.editorMode === opt.v }"
              @click="patch('editorMode', opt.v as SettingsState['editorMode'])"
            >
              {{ opt.l }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- 编辑器显示 -->
    <section class="settings-section">
      <h2 class="settings-section-title">编辑器显示</h2>
      <div class="setting-row">
        <div class="setting-label-column">
          <span class="setting-label">显示行号</span>
          <span class="setting-description">在源码编辑区左侧显示行号</span>
        </div>
        <div class="setting-control-column">
          <label class="toggle-switch">
            <input
              type="checkbox"
              :checked="draft.showLineNumbers"
              @change="patch('showLineNumbers', ($event.target as HTMLInputElement).checked)"
            />
            <span class="toggle-track" aria-hidden="true"></span>
          </label>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-label-column">
          <span class="setting-label">软折行</span>
          <span class="setting-description">超过编辑器宽度时自动换行显示</span>
        </div>
        <div class="setting-control-column">
          <label class="toggle-switch">
            <input
              type="checkbox"
              :checked="draft.softWrap"
              @change="patch('softWrap', ($event.target as HTMLInputElement).checked)"
            />
            <span class="toggle-track" aria-hidden="true"></span>
          </label>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-label-column">
          <span class="setting-label">字体大小</span>
          <span class="setting-description">编辑器字体大小，范围 12–20 px</span>
        </div>
        <div class="setting-control-column">
          <div class="number-stepper">
            <button class="stepper-btn" type="button" aria-label="减小" @click="stepFontSize(-1)">−</button>
            <input
              class="stepper-input"
              type="number"
              min="12"
              max="20"
              :value="draft.editorFontSize"
              @input="patch('editorFontSize', Number(($event.target as HTMLInputElement).value))"
            />
            <button class="stepper-btn" type="button" aria-label="增大" @click="stepFontSize(1)">+</button>
          </div>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-label-column">
          <span class="setting-label">行高</span>
          <span class="setting-description">编辑器文本行间距</span>
        </div>
        <div class="setting-control-column">
          <div class="select-wrapper">
            <select
              :value="draft.editorLineHeight"
              @change="patch('editorLineHeight', Number(($event.target as HTMLSelectElement).value))"
            >
              <option v-for="lh in LINE_HEIGHTS" :key="lh" :value="lh">{{ lh }}</option>
            </select>
            <svg class="select-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </div>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-label-column">
          <span class="setting-label">字体族</span>
          <span class="setting-description">等宽字体用于源码编辑区</span>
        </div>
        <div class="setting-control-column">
          <div class="select-wrapper">
            <select
              :value="draft.editorFontFamily"
              @change="patch('editorFontFamily', ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="ff in FONT_FAMILIES" :key="ff" :value="ff">{{ ff }}</option>
            </select>
            <svg class="select-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
