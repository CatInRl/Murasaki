<script setup lang="ts">
/**
 * SettingsApp — 设置窗口主组件
 *
 * Tauri 多窗口形态（ADR-0009），独立的 Vue 应用入口（src/settings/main.ts）。
 * 左侧分类导航（常规/编辑器/AI），右侧动态渲染对应面板。
 *
 * T8.3（Ticket #80）显式 Save 模型：
 * - 改动暂存在本地 draft（ref），点「保存」才落盘 + 触发副作用
 * - 「恢复默认」仅重置当前分类
 * - 关闭未保存时弹三按钮确认（保存 / 不保存 / 取消），复用 useDialogStore
 * - 副作用统一触发：一次 save 通过 Tauri event `settings://saved` 通知主窗口
 */
import { ref, computed, onMounted } from "vue";
import { Settings, Type, Bot } from "lucide-vue-next";
import { emit } from "@tauri-apps/api/event";
import "./settings.css";
import GeneralPanel from "./panels/GeneralPanel.vue";
import EditorPanel from "./panels/EditorPanel.vue";
import AiPanel from "./panels/AiPanel.vue";
import DialogContainer from "../components/DialogContainer.vue";
import { usePersistenceStore } from "../stores/usePersistenceStore";
import { useAiProvidersStore } from "../stores/useAiProvidersStore";
import { useDialogStore } from "../stores/useDialogStore";
import { DEFAULT_SETTINGS, type SettingsState } from "../types";
import {
  type SettingsCategory,
  isDirty,
  isCategoryDirty,
  restoreCategoryDefaults,
} from "./settingsLogic";

const persistence = usePersistenceStore();
const aiProviders = useAiProvidersStore();
const dialog = useDialogStore();

const emitClose = defineEmits<{ (e: "close"): void }>();

const activeCategory = ref<SettingsCategory>("general");

/**
 * 本地可编辑副本（保存前不写回 store）。
 * 使用 ref（而非 reactive）以支持 v-model 双向绑定：
 * Vue 编译器对 setup 顶层 ref 生成 `draft.value = $event`，避免 reactive
 * 对象在 v-model 重赋值时丢失响应式（T8.2 遗留问题）。
 */
const draft = ref<SettingsState>({ ...DEFAULT_SETTINGS });

/** 上次保存的快照，用于 dirty 比较 */
const snapshot = ref<SettingsState>({ ...DEFAULT_SETTINGS });

/** 保存中状态 */
const saving = ref(false);

/** 是否有任意未保存改动（general + editor） */
const dirty = computed(() => isDirty(draft.value, snapshot.value));

/** 当前分类是否有未保存改动（用于「恢复默认」按钮的禁用态） */
const currentCategoryDirty = computed(() =>
  isCategoryDirty(draft.value, snapshot.value, activeCategory.value)
);

onMounted(async () => {
  await persistence.loadSettings();
  draft.value = { ...persistence.settings };
  snapshot.value = { ...persistence.settings };
  await aiProviders.load();
});

function selectCategory(cat: SettingsCategory): void {
  activeCategory.value = cat;
}

/**
 * 保存：落盘 + 触发副作用。
 * 一次性把 draft 写回 persistenceStore，更新 snapshot，并通过 Tauri event
 * 通知主窗口应用副作用（ADR-0009 跨窗口通信）。
 */
async function handleSave(): Promise<void> {
  saving.value = true;
  try {
    await persistence.updateSettings({ ...draft.value });
    snapshot.value = { ...draft.value };
    await emit("settings://saved", { settings: { ...draft.value } });
  } finally {
    saving.value = false;
  }
}

/** 恢复默认：仅重置当前分类的字段（不动其他分类与未暴露字段） */
function handleRestoreDefault(): void {
  draft.value = restoreCategoryDefaults(draft.value, activeCategory.value);
}

/**
 * 关闭设置页：若有未保存改动，弹三按钮确认。
 * - 保存：先保存再关闭
 * - 不保存：直接关闭
 * - 取消：留在设置页
 *
 * 通过 emit "close" 通知父组件（App.vue）隐藏设置页（单入口路由）
 */
async function handleClose(): Promise<void> {
  if (isDirty(draft.value, snapshot.value)) {
    const choice = await dialog.unsavedChanges({
      message: "设置有未保存的修改，是否保存？",
    });
    if (choice === "cancel") return;
    if (choice === "save") {
      await handleSave();
    }
  }
  emitClose("close");
}
</script>

<template>
  <div class="settings-shell">
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
          :disabled="!currentCategoryDirty"
          @click="handleRestoreDefault"
        >
          恢复默认
        </button>
        <button
          class="secondary-button"
          type="button"
          style="margin-left: auto"
          @click="handleClose"
        >
          关闭
        </button>
        <button
          class="primary-button"
          type="button"
          :disabled="saving || !dirty"
          @click="handleSave"
        >
          {{ saving ? "保存中…" : "保存" }}
        </button>
      </div>
    </div>

    <!-- 对话框容器（复用 T2.2 系统，供关闭未保存确认使用） -->
    <DialogContainer />
  </div>
</template>