<script setup lang="ts">
import { computed } from "vue";
import { useTabsStore } from "../stores/useTabsStore";

const tabsStore = useTabsStore();

const emit = defineEmits<{
  (e: "new-tab"): void;
  /** 关闭 tab 请求（父组件负责处理未保存提示） */
  (e: "close-tab", tabId: string): void;
}>();

const tabs = computed(() => tabsStore.tabs);
const activeTabId = computed(() => tabsStore.activeTabId);

function isActive(tabId: string): boolean {
  return activeTabId.value === tabId;
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
</script>

<template>
  <div class="tab-bar-container">
    <!-- Tab 列表 -->
    <div class="tabs-list">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="tab-item"
        :class="{ active: isActive(tab.id) }"
        :title="tab.path ?? '未保存的文件'"
        @click="onClick(tab.id)"
        @mousedown="onMiddleClick($event, tab.id)"
      >
        <!-- 文件图标 -->
        <svg
          class="tab-icon"
          width="13" height="13" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="8" y1="13" x2="16" y2="13"/>
          <line x1="8" y1="17" x2="14" y2="17"/>
        </svg>
        <span class="tab-title">{{ tabsStore.getTabTitle(tab) }}</span>
        <!-- dirty 状态：紫色圆点 -->
        <span v-if="tab.isDirty" class="dirty-dot" aria-hidden="true"></span>
        <!-- 关闭按钮：仅 hover 时显示 -->
        <button
          class="close-btn"
          type="button"
          title="关闭"
          aria-label="关闭标签页"
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
      title="新建文件"
      aria-label="新建文件"
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
