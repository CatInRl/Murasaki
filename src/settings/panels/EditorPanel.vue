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
import type { SettingsState, ReadingFontPreset } from "../../types";
import { READING_FONT_PRESETS, READING_FONT_PRESET_LABELS } from "../../types";

const props = defineProps<{ modelValue: SettingsState }>();
const emit = defineEmits<{ "update:modelValue": [SettingsState] }>();

const draft = computed(() => props.modelValue);

function patch<K extends keyof SettingsState>(key: K, value: SettingsState[K]): void {
  emit("update:modelValue", { ...draft.value, [key]: value });
}

const FONT_FAMILIES = ["JetBrains Mono", "Fira Code", "Cascadia Code", "Consolas"];
const LINE_HEIGHTS = [1.4, 1.6, 1.8, 2.0];

/** 4 档阅读字体预设（A/B/C/D），值来自 types.ts 统一常量 */
const FONT_PRESET_OPTIONS: { value: ReadingFontPreset; label: string; stack: string }[] = (
  ["a", "b", "c", "d"] as ReadingFontPreset[]
).map((v) => ({
  value: v,
  label: READING_FONT_PRESET_LABELS[v],
  stack: READING_FONT_PRESETS[v],
}));

function stepFontSize(delta: number): void {
  const next = Math.min(20, Math.max(12, draft.value.editorFontSize + delta));
  patch("editorFontSize", next);
}
</script>

<template>
  <div>
    <h1 class="settings-page-title">{{ $t('settings.editor.title') }}</h1>

    <!-- 编辑模式 -->
    <section class="settings-section">
      <h2 class="settings-section-title">{{ $t('settings.editor.editorMode') }}</h2>
      <div class="setting-row">
        <div class="setting-label-column">
          <span class="setting-label">{{ $t('settings.editor.editorMode') }}</span>
          <span class="setting-description">{{ $t('settings.editor.editorModeDesc') }}</span>
        </div>
        <div class="setting-control-column">
          <div class="segmented-control" role="radiogroup" :aria-label="$t('settings.editor.editorMode')">
            <button
              v-for="opt in [
                { v: 'source', l: $t('settings.editor.editorModeSource') },
                { v: 'split', l: $t('settings.editor.editorModeSplit') },
                { v: 'wysiwyg', l: $t('settings.editor.editorModeWysiwyg') },
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
      <h2 class="settings-section-title">{{ $t('settings.editor.editorMode') }}</h2>
      <div class="setting-row">
        <div class="setting-label-column">
          <span class="setting-label">{{ $t('settings.editor.showLineNumbers') }}</span>
          <span class="setting-description">{{ $t('settings.editor.showLineNumbersDesc') }}</span>
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
          <span class="setting-label">{{ $t('settings.editor.softWrap') }}</span>
          <span class="setting-description">{{ $t('settings.editor.softWrapDesc') }}</span>
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
          <span class="setting-label">{{ $t('settings.editor.fontSize') }}</span>
          <span class="setting-description">{{ $t('settings.editor.fontSizeDesc') }}</span>
        </div>
        <div class="setting-control-column">
          <div class="number-stepper">
            <button class="stepper-btn" type="button" aria-label="−" @click="stepFontSize(-1)">−</button>
            <input
              class="stepper-input"
              type="number"
              min="12"
              max="20"
              :value="draft.editorFontSize"
              @input="patch('editorFontSize', Number(($event.target as HTMLInputElement).value))"
            />
            <button class="stepper-btn" type="button" aria-label="+" @click="stepFontSize(1)">+</button>
          </div>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-label-column">
          <span class="setting-label">{{ $t('settings.editor.lineHeight') }}</span>
          <span class="setting-description">{{ $t('settings.editor.lineHeightDesc') }}</span>
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
          <span class="setting-label">{{ $t('settings.editor.fontPreset') }}</span>
          <span class="setting-description">{{ $t('settings.editor.fontPresetDesc') }}</span>
        </div>
        <div class="setting-control-column">
          <div class="font-preset-grid" role="radiogroup" :aria-label="$t('settings.editor.fontPreset')">
            <button
              v-for="p in FONT_PRESET_OPTIONS"
              :key="p.value"
              type="button"
              class="font-preset-card"
              :class="{ active: draft.editorFontPreset === p.value }"
              :style="{ fontFamily: p.stack }"
              role="radio"
              :aria-checked="draft.editorFontPreset === p.value"
              @click="patch('editorFontPreset', p.value)"
            >
              <span class="font-preset-name">{{ $t(p.label) }}</span>
              <span class="font-preset-sample">Aa 中文 123</span>
            </button>
          </div>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-label-column">
          <span class="setting-label">{{ $t('settings.editor.fontFamily') }}</span>
          <span class="setting-description">{{ $t('settings.editor.fontFamilyDesc') }}</span>
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
