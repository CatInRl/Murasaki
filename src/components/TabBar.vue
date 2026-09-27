<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { NPopover, NScrollbar } from "naive-ui";
import { X, Copy, FolderOpen, ArrowUpRight, LayoutList } from "lucide-vue-next";
import { useTabsStore } from "../stores/useTabsStore";
import { useFileOpsStore } from "../stores/useFileOpsStore";
import { useContextMenuStore } from "../stores/useContextMenuStore";
import { useDialogStore } from "../stores/useDialogStore";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { isTabOutOfWorkspace } from "../utils/path";
import { buildTabList, filterTabList } from "../utils/tabList";
import type { TabListEntry } from "../utils/tabList";
import { formatShortcutForDisplay } from "../shortcuts/shortcutsLogic";
import type { MenuItem } from "../stores/useContextMenuStore";
import type { Tab } from "../types";

const tabsStore = useTabsStore();
const fileOps = useFileOpsStore();
const contextMenu = useContextMenuStore();
const dialog = useDialogStore();
const workspace = useWorkspaceStore();
const { t } = useI18n();

/**
 * 「全部标签」面板的展开状态**由父组件持有**：这样快捷键命令（useCommands）
 * 与按钮点击走同一条路径，不必为面板再造一个 store。详见 CONTEXT.md「全部标签面板」。
 */
const props = defineProps<{ allTabsOpen: boolean }>();

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
  /** 「全部标签」面板展开状态变化 */
  (e: "update:allTabsOpen", open: boolean): void;
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
 * 判定收敛在 `utils/path.isTabOutOfWorkspace`，与「全部标签」面板同源。
 */
function isOutOfWorkspace(tab: Tab): boolean {
  return isTabOutOfWorkspace(workspace.workspacePath, tab.path);
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

// ===== 全部标签面板（issue #168 / #279）=====
// 定位器语义：只按标题 + 所在目录过滤，顺序与标签栏一致（见 CONTEXT.md）

const tabQuery = ref("");
/** 键盘高亮项下标（-1 = 焦点在搜索框） */
const focusIndex = ref(-1);
const searchInputRef = ref<HTMLInputElement | null>(null);
const allTabsBtnRef = ref<HTMLButtonElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);

const tabEntries = computed(() =>
  buildTabList(tabsStore.tabs, {
    activeTabId: tabsStore.activeTabId,
    workspacePath: workspace.workspacePath,
    titleOf: (tab) => tabsStore.getTabTitle(tab),
  })
);
const filteredEntries = computed(() => filterTabList(tabEntries.value, tabQuery.value));

/**
 * 受控展开：单项关闭会弹全局确认对话框（挂在 body 上），对 NPopover 而言是「外部点击」。
 * 面板在确认期间保持打开（面向「连续整理」场景），故此处挂起那次关闭请求。
 */
function onAllTabsShowUpdate(next: boolean): void {
  if (!next && dialog.isOpen) return;
  emit("update:allTabsOpen", next);
}

/** 打开时聚焦搜索框（过滤几乎总是第一步）；关闭时清空查询与高亮 */
watch(
  () => props.allTabsOpen,
  (open) => {
    if (open) {
      // flush: "post" 保证 NPopover 的内容（含搜索框）已挂载
      void nextTick(() => searchInputRef.value?.focus());
      return;
    }
    tabQuery.value = "";
    focusIndex.value = -1;
  },
  { flush: "post" }
);

function closeAllTabsPanel(): void {
  emit("update:allTabsOpen", false);
}

/** 过滤条件变化后旧的高亮下标可能越界或指错行，回到「焦点在搜索框」的初始态 */
watch(tabQuery, () => {
  focusIndex.value = -1;
});

/** 定位到某个标签：切换 + 关面板（列表由 store 派生，无需手动同步） */
function activateEntry(entry: TabListEntry): void {
  tabsStore.switchTo(entry.id);
  closeAllTabsPanel();
}

function onCloseEntry(e: MouseEvent, entry: TabListEntry): void {
  e.stopPropagation();
  // 未保存提示仍由父组件（useTabClose）处理；关掉或取消后列表自动同步
  emit("close-tab", entry.id);
}

/** 把键盘高亮滚入可视区并聚焦该行 */
function moveFocus(next: number): void {
  const max = filteredEntries.value.length - 1;
  if (max < 0) return;
  focusIndex.value = Math.min(Math.max(next, -1), max);
  void nextTick(() => {
    if (focusIndex.value < 0) {
      searchInputRef.value?.focus();
      return;
    }
    const row = panelRef.value?.querySelector<HTMLElement>(".all-tabs-item.focused");
    row?.focus();
    row?.scrollIntoView({ block: "nearest" });
  });
}

function onPanelKeydown(e: KeyboardEvent): void {
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      moveFocus(focusIndex.value + 1);
      break;
    case "ArrowUp":
      e.preventDefault();
      moveFocus(focusIndex.value - 1);
      break;
    case "Enter": {
      e.preventDefault();
      const target = filteredEntries.value[focusIndex.value] ?? filteredEntries.value[0];
      if (target) activateEntry(target);
      break;
    }
    case "Escape":
      e.preventDefault();
      closeAllTabsPanel();
      // 焦点还给入口按钮，留一条再次打开的路（不回编辑器）
      void nextTick(() => allTabsBtnRef.value?.focus());
      break;
  }
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

    <!-- 全部标签：常驻入口（固定宽度、不参与标签区压缩），详见 CONTEXT.md -->
    <NPopover
      :show="allTabsOpen"
      trigger="click"
      placement="bottom-end"
      :show-arrow="false"
      :style="{ padding: 0 }"
      @update:show="onAllTabsShowUpdate"
    >
      <template #trigger>
        <button
          ref="allTabsBtnRef"
          class="all-tabs-btn"
          type="button"
          :title="$t('editor.tabBar.allTabs')"
          :aria-label="$t('editor.tabBar.allTabs')"
          :aria-expanded="allTabsOpen"
          data-testid="all-tabs-btn"
        >
          <LayoutList :size="14" aria-hidden="true" />
          <span class="all-tabs-count">{{ tabs.length }}</span>
        </button>
      </template>

      <div ref="panelRef" class="all-tabs-panel" data-testid="all-tabs-panel" @keydown="onPanelKeydown">
        <input
          ref="searchInputRef"
          v-model="tabQuery"
          class="all-tabs-search"
          type="text"
          :placeholder="$t('editor.tabBar.allTabsSearchPlaceholder')"
          :aria-label="$t('editor.tabBar.allTabsSearchPlaceholder')"
        />
        <NScrollbar class="all-tabs-scroll" :style="{ maxHeight: '320px' }">
          <div class="all-tabs-list" role="listbox">
            <p v-if="filteredEntries.length === 0" class="all-tabs-empty">
              {{ $t('editor.tabBar.allTabsEmpty') }}
            </p>
            <div
              v-for="(entry, i) in filteredEntries"
              :key="entry.id"
              class="all-tabs-item"
              :class="{ active: entry.isActive, focused: i === focusIndex }"
              role="option"
              :aria-selected="entry.isActive"
              :tabindex="i === focusIndex ? 0 : -1"
              :title="entry.subtitle ?? entry.title"
              @click="activateEntry(entry)"
            >
              <ArrowUpRight
                v-if="entry.isOutOfWorkspace"
                class="all-tabs-mark"
                :size="12"
                aria-hidden="true"
              />
              <span class="all-tabs-text">
                <span class="all-tabs-title">{{ entry.title }}</span>
                <span class="all-tabs-subtitle">{{ entry.subtitle ?? $t('common.untitled') }}</span>
              </span>
              <span v-if="entry.isDirty" class="dirty-dot" aria-hidden="true"></span>
              <button
                class="all-tabs-close"
                type="button"
                :title="$t('editor.tabBar.close')"
                :aria-label="$t('editor.tabBar.closeTabAria')"
                @click="onCloseEntry($event, entry)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          </div>
        </NScrollbar>
      </div>
    </NPopover>

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

/* ===== 全部标签入口 + 面板（issue #168 / #279）===== */
/* 入口固定宽度、不参与标签区压缩：收起时它仍要能点开，所以不能跟着溢出被挤掉 */
.all-tabs-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 28px;
  min-width: 40px;
  margin-bottom: 2px;
  padding: 0 6px;
  border: none;
  background: transparent;
  color: var(--murasaki-ink-3);
  border-radius: var(--murasaki-radius-sm);
  cursor: pointer;
  flex-shrink: 0;
  transition: background var(--murasaki-duration-fast) var(--murasaki-ease),
              color var(--murasaki-duration-fast) var(--murasaki-ease);
}

.all-tabs-btn:hover,
.all-tabs-btn[aria-expanded="true"] {
  background: var(--murasaki-neutral-200);
  color: var(--murasaki-ink-2);
}

.all-tabs-count {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.all-tabs-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 320px;
  max-width: 80vw;
  padding: 8px;
}

.all-tabs-search {
  width: 100%;
  height: 30px;
  padding: 0 8px;
  font-size: 12px;
  font-family: inherit;
  color: var(--murasaki-ink);
  background: var(--murasaki-background);
  border: 1px solid var(--murasaki-border);
  border-radius: var(--murasaki-radius-sm);
  outline: none;
  transition: border-color var(--murasaki-duration-fast) var(--murasaki-ease);
}

.all-tabs-search:focus {
  border-color: var(--murasaki-primary);
}

.all-tabs-scroll {
  width: 100%;
}

.all-tabs-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--murasaki-radius-sm);
  cursor: pointer;
  outline: none;
  transition: background var(--murasaki-duration-fast) var(--murasaki-ease);
}

.all-tabs-item:hover {
  background: var(--murasaki-neutral-100);
}

.all-tabs-item.active {
  background: color-mix(in srgb, var(--murasaki-primary) 10%, transparent);
}

/* 键盘高亮独立于鼠标 hover，便于「↓ 进列表」后看清落点 */
.all-tabs-item.focused {
  box-shadow: inset 0 0 0 1px var(--murasaki-primary);
}

.all-tabs-mark {
  flex-shrink: 0;
  color: var(--murasaki-ink-3);
}

.all-tabs-text {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
}

.all-tabs-title,
.all-tabs-subtitle {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.all-tabs-title {
  font-size: 12.5px;
  color: var(--murasaki-ink);
}

.all-tabs-item.active .all-tabs-title {
  color: var(--murasaki-primary);
}

.all-tabs-subtitle {
  font-size: 11px;
  color: var(--murasaki-ink-3);
}

/* 关闭按钮与标签栏同款：hover 才显，避免列表看起来像一排叉号 */
.all-tabs-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--murasaki-ink-3);
  border-radius: var(--murasaki-radius-sm);
  cursor: pointer;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity var(--murasaki-duration-fast) var(--murasaki-ease),
              background var(--murasaki-duration-fast) var(--murasaki-ease),
              color var(--murasaki-duration-fast) var(--murasaki-ease);
}

.all-tabs-item:hover .all-tabs-close,
.all-tabs-item.focused .all-tabs-close {
  opacity: 1;
}

.all-tabs-close:hover {
  background: var(--murasaki-neutral-300);
  color: var(--murasaki-ink);
}

.all-tabs-empty {
  padding: 12px 0;
  font-size: 12px;
  color: var(--murasaki-ink-3);
  text-align: center;
}

/* 触屏：始终显示关闭按钮 */
@media (pointer: coarse) {
  .close-btn {
    opacity: 1;
  }
  .all-tabs-close {
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
  .all-tabs-btn {
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
