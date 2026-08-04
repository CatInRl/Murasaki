<script setup lang="ts">
/**
 * ShortcutPanel — 快捷键设置面板（issue #97）
 *
 * 显示所有应用快捷键，按功能分类组织：
 * - 文件操作 / 编辑操作 / 段落格式化 / 视图切换 / Agent
 *
 * 快捷键数据来自 menu.rs 与 useEditorCommands.ts，保持与原生菜单一致。
 * 当前版本以展示为主，不支持自定义录制（0.5.0 后续版本再实现）。
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";

const { t } = useI18n();

interface ShortcutEntry {
  id: string;
  labelKey: string;
  shortcut: string;
  category: "file" | "edit" | "paragraph" | "view" | "agent";
}

/**
 * 静态快捷键清单（与原生菜单保持一致，后续改为动态生成）
 * key 使用 vue-i18n 路径，便于国际化
 */
const SHORTCUTS: ShortcutEntry[] = [
  // 文件操作
  { id: "new-file", labelKey: "settings.shortcuts.newFile", shortcut: "Ctrl+N", category: "file" },
  { id: "open-file", labelKey: "settings.shortcuts.openFile", shortcut: "Ctrl+O", category: "file" },
  { id: "open-folder", labelKey: "settings.shortcuts.openFolder", shortcut: "Ctrl+Shift+O", category: "file" },
  { id: "save", labelKey: "settings.shortcuts.save", shortcut: "Ctrl+S", category: "file" },
  { id: "save-as", labelKey: "settings.shortcuts.saveAs", shortcut: "Ctrl+Shift+S", category: "file" },
  { id: "close-tab", labelKey: "settings.shortcuts.closeTab", shortcut: "Ctrl+W", category: "file" },
  { id: "reload-file", labelKey: "settings.shortcuts.reloadFile", shortcut: "Ctrl+R", category: "file" },
  { id: "quit", labelKey: "settings.shortcuts.quit", shortcut: "Ctrl+Q", category: "file" },

  // 编辑操作
  { id: "undo", labelKey: "settings.shortcuts.undo", shortcut: "Ctrl+Z", category: "edit" },
  { id: "redo", labelKey: "settings.shortcuts.redo", shortcut: "Ctrl+Y", category: "edit" },
  { id: "cut", labelKey: "settings.shortcuts.cut", shortcut: "Ctrl+X", category: "edit" },
  { id: "copy", labelKey: "settings.shortcuts.copy", shortcut: "Ctrl+C", category: "edit" },
  { id: "paste", labelKey: "settings.shortcuts.paste", shortcut: "Ctrl+V", category: "edit" },
  { id: "select-all", labelKey: "settings.shortcuts.selectAll", shortcut: "Ctrl+A", category: "edit" },
  { id: "find", labelKey: "settings.shortcuts.find", shortcut: "Ctrl+F", category: "edit" },
  { id: "replace", labelKey: "settings.shortcuts.replace", shortcut: "Ctrl+H", category: "edit" },
  { id: "find-in-files", labelKey: "settings.shortcuts.findInFiles", shortcut: "Ctrl+Shift+F", category: "edit" },

  // 段落格式化
  { id: "heading-1", labelKey: "settings.shortcuts.heading1", shortcut: "Ctrl+1", category: "paragraph" },
  { id: "heading-2", labelKey: "settings.shortcuts.heading2", shortcut: "Ctrl+2", category: "paragraph" },
  { id: "heading-3", labelKey: "settings.shortcuts.heading3", shortcut: "Ctrl+3", category: "paragraph" },
  { id: "heading-4", labelKey: "settings.shortcuts.heading4", shortcut: "Ctrl+4", category: "paragraph" },
  { id: "heading-5", labelKey: "settings.shortcuts.heading5", shortcut: "Ctrl+5", category: "paragraph" },
  { id: "heading-6", labelKey: "settings.shortcuts.heading6", shortcut: "Ctrl+6", category: "paragraph" },
  { id: "normal", labelKey: "settings.shortcuts.normal", shortcut: "Ctrl+0", category: "paragraph" },
  { id: "code-block", labelKey: "settings.shortcuts.codeBlock", shortcut: "Ctrl+Shift+K", category: "paragraph" },
  { id: "blockquote", labelKey: "settings.shortcuts.blockquote", shortcut: "Ctrl+Shift+Q", category: "paragraph" },
  { id: "unordered-list", labelKey: "settings.shortcuts.unorderedList", shortcut: "Ctrl+Shift+]", category: "paragraph" },
  { id: "ordered-list", labelKey: "settings.shortcuts.orderedList", shortcut: "Ctrl+Shift+[", category: "paragraph" },
  { id: "task-list", labelKey: "settings.shortcuts.taskList", shortcut: "Ctrl+Shift+X", category: "paragraph" },

  // 视图切换
  { id: "toggle-sidebar", labelKey: "settings.shortcuts.toggleSidebar", shortcut: "Ctrl+Shift+E", category: "view" },
  { id: "toggle-outline", labelKey: "settings.shortcuts.toggleOutline", shortcut: "Ctrl+Shift+M", category: "view" },
  { id: "switch-tab-next", labelKey: "settings.shortcuts.switchTabNext", shortcut: "Ctrl+Tab", category: "view" },
  { id: "switch-tab-prev", labelKey: "settings.shortcuts.switchTabPrev", shortcut: "Ctrl+Shift+Tab", category: "view" },
  { id: "fullscreen", labelKey: "settings.shortcuts.fullscreen", shortcut: "F11", category: "view" },
  { id: "toggle-statusbar", labelKey: "settings.shortcuts.toggleStatusbar", shortcut: "Alt+Shift+S", category: "view" },
];

const CATEGORY_LABELS: Record<ShortcutEntry["category"], string> = {
  file: "settings.shortcuts.categories.file",
  edit: "settings.shortcuts.categories.edit",
  paragraph: "settings.shortcuts.categories.paragraph",
  view: "settings.shortcuts.categories.view",
  agent: "settings.shortcuts.categories.agent",
};

/** 按分类分组的快捷键列表 */
const groupedShortcuts = computed(() => {
  const groups: Record<string, ShortcutEntry[]> = {
    file: [],
    edit: [],
    paragraph: [],
    view: [],
  };
  for (const s of SHORTCUTS) {
    groups[s.category].push(s);
  }
  return Object.entries(groups)
    .filter(([, v]) => v.length > 0)
    .map(([cat, list]) => ({
      category: cat as ShortcutEntry["category"],
      label: t(CATEGORY_LABELS[cat as ShortcutEntry["category"]]),
      list,
    }));
});
</script>

<template>
  <div>
    <h1 class="settings-page-title">{{ $t('settings.shortcuts.title') }}</h1>
    <p class="settings-page-description">{{ $t('settings.shortcuts.description') }}</p>

    <div v-for="group in groupedShortcuts" :key="group.category" class="settings-section">
      <h2 class="settings-section-title">{{ group.label }}</h2>
      <div class="shortcut-list">
        <div
          v-for="entry in group.list"
          :key="entry.id"
          class="shortcut-row"
        >
          <span class="shortcut-label">{{ t(entry.labelKey) }}</span>
          <span class="shortcut-key">{{ entry.shortcut }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-page-description {
  margin: 0 0 20px;
  color: var(--murasaki-ink-3, #999);
  font-size: 13px;
  line-height: 1.5;
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
  padding: 8px 12px;
  border-radius: var(--murasaki-radius-sm, 4px);
  transition: background-color 0.15s ease;
}
.shortcut-row:hover {
  background-color: var(--murasaki-surface-2, #f5f5f5);
}
.shortcut-label {
  font-size: 14px;
  color: var(--murasaki-ink, #333);
}
.shortcut-key {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  font-family: var(--murasaki-font-mono, monospace);
  font-size: 12px;
  font-weight: 500;
  color: var(--murasaki-ink-2, #666);
  background: var(--murasaki-surface, #fff);
  border: 1px solid var(--murasaki-border, #e0e0e0);
  border-radius: 4px;
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.05);
}
</style>
