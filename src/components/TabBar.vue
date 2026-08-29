<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { X, Copy, FolderOpen, ArrowUpRight } from "lucide-vue-next";
import { useTabsStore } from "../stores/useTabsStore";
import { useFileOpsStore } from "../stores/useFileOpsStore";
import { useContextMenuStore } from "../stores/useContextMenuStore";
import { useDialogStore } from "../stores/useDialogStore";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { isPathUnder } from "../utils/path";
import { formatShortcutForDisplay } from "../shortcuts/shortcutsLogic";
import type { MenuItem } from "../stores/useContextMenuStore";
import type { Tab } from "../types";

const tabsStore = useTabsStore();
const fileOps = useFileOpsStore();
const contextMenu = useContextMenuStore();
const dialog = useDialogStore();
const workspace = useWorkspaceStore();
const { t } = useI18n();

const tabsListRef = ref<HTMLElement | null>(null);

const emit = defineEmits<{
  (e: "new-tab"): void;
  /** 关闭 tab 请求（父组件负责处理未保存提示） */
  (e: "close-tab", tabId: string): void;
  /** 关闭其他 tab（父组件批量处理） */
  (e: "close-others", tabId: string): void;
  /** 关闭右侧 tab */
  (e: "close-right", tabId: string): void;
  /** 关闭左侧 tab */
  (e: "close-left", tabId: string): void;
  /** 关闭所有 tab */
  (e: "close-all"): void;
}>();

const tabs = computed(() => tabsStore.tabs);
const activeTabId = computed(() => tabsStore.activeTabId);

/**
 * 把激活 tab 滚动到可见区域。
 * 窗口缩小时 tab 会横向溢出，若激活 tab 落在可视区外将无法选中/关闭，需自动滚动。
 */
function scrollActiveTabIntoView(): void {
  const list = tabsListRef.value;
  if (!list) return;
  const active = list.querySelector<HTMLElement>(".tab-item.active");
  if (!active) return;
  const left = active.offsetLeft;
  const right = left + active.offsetWidth;
  const viewLeft = list.scrollLeft;
  const viewRight = viewLeft + list.clientWidth;
  if (left < viewLeft) {
    list.scrollLeft = left;
  } else if (right > viewRight) {
    list.scrollLeft = right - list.clientWidth;
  }
}

// 激活 tab 变化 / tab 数量变化时，把激活 tab 滚动到可见区域
watch(
  [activeTabId, () => tabs.value.length],
  () => {
    void nextTick(scrollActiveTabIntoView);
  }
);

// 窗口缩放（/ tab 栏宽度变化）时，tab 可能横向溢出，激活 tab 可能被推出可视区。
// 用 ResizeObserver 监听容器宽度变化，确保激活 tab 始终可见、可选中与关闭。
let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  const list = tabsListRef.value;
  if (!list || typeof ResizeObserver === "undefined") return;
  resizeObserver = new ResizeObserver(() => {
    void nextTick(scrollActiveTabIntoView);
  });
  resizeObserver.observe(list);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});

function isActive(tabId: string): boolean {
  return activeTabId.value === tabId;
}

/**
 * 工作区归属：tab 是否位于当前工作区之外。
 * 派生布尔属性：由 workspacePath 与 tab.path 实时计算（前缀 + 目录边界 + 大小写不敏感）。
 * 未保存 tab（path=null）与无工作区时均视为工作区内（不加角标）。
 */
function isOutOfWorkspace(tab: Tab): boolean {
  const ws = workspace.workspacePath;
  if (!ws || !tab.path) return false;
  return !isPathUnder(ws, tab.path);
}

/** tab 的 hover 提示：工作区外 tab 加前缀 */
function tabTooltip(tab: Tab): string {
  const base = tab.path ?? t("common.status.unsavedFile");
  return isOutOfWorkspace(tab) ? t("editor.tabBar.outOfWorkspacePrefix") + base : base;
}

function onClick(tabId: string): void {
  tabsStore.switchTo(tabId);
}

/**
 * 中键点击关闭 tab
 */
function onMiddleClick(e: MouseEvent, tabId: string): void {
  // e.button === 1 是中键
  if (e.button === 1) {
    e.preventDefault();
    emit("close-tab", tabId);
  }
}

/**
 * 点击 X 关闭按钮
 */
function onCloseTab(e: MouseEvent, tabId: string): void {
  e.stopPropagation();
  emit("close-tab", tabId);
}

/**
 * 点击 + 新建 tab
 */
function onNewTab(): void {
  emit("new-tab");
}

// ===== 右键菜单 =====
function onContextMenu(e: MouseEvent, tab: Tab): void {
  // 先切换到右键的 tab，让批量操作的目标更直观
  tabsStore.switchTo(tab.id);

  const hasPath = !!tab.path;
  const items: MenuItem[] = [
    { label: t("editor.tabBar.close"), icon: X, shortcut: formatShortcutForDisplay("Ctrl+W") ?? "", action: () => emit("close-tab", tab.id) },
    { label: t("editor.tabBar.closeOthers"), action: () => emit("close-others", tab.id) },
    { label: t("editor.tabBar.closeRight"), action: () => emit("close-right", tab.id) },
    { label: t("editor.tabBar.closeLeft"), action: () => emit("close-left", tab.id) },
    { label: t("editor.tabBar.closeAll"), action: () => emit("close-all") },
    { separator: true },
    {
      label: t("common.copyPath"),
      icon: Copy,
      disabled: !hasPath,
      action: async () => {
        if (!tab.path) return;
        try {
          await fileOps.copyAbsolutePath(tab.path);
        } catch (err) {
          void dialog.alert({ title: t("common.dialog.errorTitle"), message: t("common.error.copyPathFailed", { error: String(err) }), variant: "error" });
        }
      },
    },
    {
      label: t("common.revealInExplorer"),
      icon: FolderOpen,
      disabled: !hasPath,
      action: async () => {
        if (!tab.path) return;
        try {
          await fileOps.revealInExplorer(tab.path);
        } catch (err) {
          void dialog.alert({ title: t("common.dialog.errorTitle"), message: t("common.error.revealFailed", { error: String(err) }), variant: "error" });
        }
      },
    },
  ];
  contextMenu.show(e, items);
}
</script>

<template>
  <div class="tab-bar-container">
    <!-- Tab 列表 -->
    <div ref="tabsListRef" class="tabs-list">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="tab-item"
        :class="{ active: isActive(tab.id) }"
        :title="tabTooltip(tab)"
        @click="onClick(tab.id)"
        @mousedown="onMiddleClick($event, tab.id)"
        @contextmenu="onContextMenu($event, tab)"
      >
        <!-- 文件图标：工作区外 tab 用 ↗ 角标替换 -->
        <svg
          v-if="!isOutOfWorkspace(tab)"
          class="tab-icon"
          width="13" height="13" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="8" y1="13" x2="16" y2="13"/>
          <line x1="8" y1="17" x2="14" y2="17"/>
        </svg>
        <ArrowUpRight v-else class="tab-icon" :size="13" :stroke-width="2" aria-hidden="true" />
        <span class="tab-title">{{ tabsStore.getTabTitle(tab) }}</span>
        <!-- dirty 状态：紫色圆点 -->
        <span v-if="tab.isDirty" class="dirty-dot" aria-hidden="true"></span>
        <!-- 关闭按钮：仅 hover 时显示 -->
        <button
          class="close-btn"
          type="button"
          :title="$t('editor.tabBar.close')"
          :aria-label="$t('editor.tabBar.closeTabAria')"
          @click="onCloseTab($event, tab.id)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- + 按钮 -->
    <button
      class="new-tab-btn"
      type="button"
      :title="$t('editor.tabBar.newTab')"
      :aria-label="$t('editor.tabBar.newTab')"
      @click="onNewTab"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    </button>
  </div>
</template>

<style scoped>
.tab-bar-container {
  display: flex;
  align-items: flex-end;
  height: 100%;
  gap: 2px;
  padding: 0 4px;
}

.tabs-list {
  display: flex;
  align-items: flex-end;
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.tabs-list::-webkit-scrollbar {
  display: none;
}

.tab-item {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  font-size: 13px;
  color: var(--murasaki-ink-3);
  cursor: pointer;
  user-select: none;
  background: transparent;
  border-bottom: 2px solid transparent;
  flex-shrink: 0;
  max-width: 220px;
  position: relative;
  transition:
    background var(--murasaki-duration-fast) var(--murasaki-ease),
    color var(--murasaki-duration-fast) var(--murasaki-ease),
    border-color var(--murasaki-duration-fast) var(--murasaki-ease);
}

.tab-item:hover {
  color: var(--murasaki-ink-2);
  background: var(--murasaki-neutral-100);
}

.tab-item.active {
  color: var(--murasaki-ink);
  background: var(--murasaki-background);
  border-bottom-color: var(--murasaki-primary);
}

.tab-icon {
  width: 13px;
  height: 13px;
  color: var(--murasaki-ink-3);
  flex-shrink: 0;
}

.tab-item.active .tab-icon {
  color: var(--murasaki-primary);
}

.tab-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dirty-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--murasaki-primary);
  flex-shrink: 0;
  animation: murasaki-pulse-soft 2.4s ease-in-out infinite;
}

.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  color: var(--murasaki-ink-3);
  border-radius: var(--murasaki-radius-sm);
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
  opacity: 0;
  margin-left: 2px;
  transition: opacity var(--murasaki-duration-fast) var(--murasaki-ease),
              background var(--murasaki-duration-fast) var(--murasaki-ease),
              color var(--murasaki-duration-fast) var(--murasaki-ease);
}

.tab-item:hover .close-btn {
  opacity: 1;
}

.close-btn:hover {
  background: var(--murasaki-neutral-300);
  color: var(--murasaki-ink);
}

.new-tab-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-bottom: 2px;
  border: none;
  background: transparent;
  color: var(--murasaki-ink-3);
  border-radius: var(--murasaki-radius-sm);
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
  transition: background var(--murasaki-duration-fast) var(--murasaki-ease),
              color var(--murasaki-duration-fast) var(--murasaki-ease),
              transform var(--murasaki-duration-fast) var(--murasaki-ease);
}

.new-tab-btn:hover {
  background: var(--murasaki-neutral-200);
  color: var(--murasaki-ink-2);
}

.new-tab-btn:active {
  transform: scale(0.94);
}

/* 触屏：始终显示关闭按钮 */
@media (pointer: coarse) {
  .close-btn {
    opacity: 1;
  }
  .tab-item {
    height: 36px;
    padding: 0 14px;
  }
  .new-tab-btn {
    width: 36px;
    height: 36px;
  }
}

/* 紧凑窗口 */
@media (max-width: 980px) {
  .tab-item {
    max-width: 160px;
    padding: 0 10px;
  }
}
</style>
