<script setup lang="ts">
/**
 * SettingsApp — 设置窗口主组件
 *
 * Tauri 多窗口形态（ADR-0009），独立的 Vue 应用入口（src/settings/main.ts）。
 * 左侧分类导航（常规/编辑器/AI），右侧动态渲染对应面板。
 *
 * T8.2 仅实现表单显示与编辑；显式 Save 模型（dirty 追踪 + 未保存确认）属于 T8.3。
 * 当前实现：面板编辑本地 draft，点击「保存」持久化到 persistenceStore。
 */
import { ref, reactive, onMounted } from "vue";
import { Settings, Type, Bot, X } from "lucide-vue-next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import GeneralPanel from "./panels/GeneralPanel.vue";
import EditorPanel from "./panels/EditorPanel.vue";
import AiPanel from "./panels/AiPanel.vue";
import { usePersistenceStore } from "../stores/usePersistenceStore";
import { useAiProvidersStore } from "../stores/useAiProvidersStore";
import { DEFAULT_SETTINGS, type SettingsState } from "../types";

type Category = "general" | "editor" | "ai";

const persistence = usePersistenceStore();
const aiProviders = useAiProvidersStore();

const activeCategory = ref<Category>("general");

/** 本地可编辑副本（保存前不写回 store） */
const draft = reactive<SettingsState>({ ...DEFAULT_SETTINGS });

/** 保存中状态 */
const saving = ref(false);

onMounted(async () => {
  await persistence.loadSettings();
  Object.assign(draft, persistence.settings);
  await aiProviders.load();
});

function selectCategory(cat: Category): void {
  activeCategory.value = cat;
}

async function handleSave(): Promise<void> {
  saving.value = true;
  try {
    await persistence.updateSettings({ ...draft });
  } finally {
    saving.value = false;
  }
}

function handleRestoreDefault(): void {
  Object.assign(draft, DEFAULT_SETTINGS);
}

async function handleClose(): Promise<void> {
  // T8.3 将在此处添加未保存确认对话框
  await getCurrentWindow().close();
}
</script>

<template>
  <div class="settings-shell">
    <!-- Title Bar -->
    <div class="settings-title-bar">
      <div class="settings-title-text">
        <Settings :size="16" />
        <span>设置</span>
      </div>
      <button
        class="settings-title-close"
        type="button"
        aria-label="关闭"
        @click="handleClose"
      >
        <X :size="16" />
      </button>
    </div>

    <!-- Sidebar -->
    <nav class="settings-sidebar" aria-label="设置分类">
      <div class="settings-category-list">
        <button
          type="button"
          class="category-item"
          :class="{ active: activeCategory === 'general' }"
          @click="selectCategory('general')"
        >
          <Settings :size="16" />
          <span>常规</span>
        </button>
        <button
          type="button"
          class="category-item"
          :class="{ active: activeCategory === 'editor' }"
          @click="selectCategory('editor')"
        >
          <Type :size="16" />
          <span>编辑器</span>
        </button>
        <button
          type="button"
          class="category-item"
          :class="{ active: activeCategory === 'ai' }"
          @click="selectCategory('ai')"
        >
          <Bot :size="16" />
          <span>AI</span>
        </button>
      </div>
    </nav>

    <!-- Content -->
    <div class="settings-content">
      <div class="settings-content-inner">
        <GeneralPanel
          v-if="activeCategory === 'general'"
          v-model="draft"
        />
        <EditorPanel
          v-else-if="activeCategory === 'editor'"
          v-model="draft"
        />
        <AiPanel v-else-if="activeCategory === 'ai'" />
      </div>

      <!-- Footer -->
      <div class="settings-footer">
        <button
          class="secondary-button"
          type="button"
          @click="handleRestoreDefault"
        >
          恢复默认
        </button>
        <button
          class="primary-button"
          type="button"
          :disabled="saving"
          @click="handleSave"
        >
          {{ saving ? "保存中…" : "保存" }}
        </button>
      </div>
    </div>
  </div>
</template>
