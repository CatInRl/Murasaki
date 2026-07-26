<script setup lang="ts">
import { computed } from "vue";
import { NButton } from "naive-ui";
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
        <span class="tab-title">{{ tabsStore.getTabTitle(tab) }}</span>
        <span v-if="tab.isDirty" class="dirty-mark">•</span>
        <button
          class="close-btn"
          title="关闭"
          @click="onCloseTab($event, tab.id)"
        >
          ×
        </button>
      </div>
    </div>

    <!-- + 按钮 -->
    <NButton
      class="new-tab-btn"
      quaternary
      circle
      size="tiny"
      title="新建文件"
      @click="onNewTab"
    >
      +
    </NButton>
  </div>
</template>

<style scoped>
.tab-bar-container {
  display: flex;
  align-items: center;
  height: 100%;
  gap: 4px;
  padding: 0 4px;
}
.tabs-list {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
}
.tabs-list::-webkit-scrollbar {
  height: 2px;
}
.tabs-list::-webkit-scrollbar-thumb {
  background: #ccc;
}
.tab-item {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 6px 0 10px;
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
  font-size: 12px;
  color: #555;
  background: transparent;
  flex-shrink: 0;
  max-width: 200px;
  transition: background 0.1s;
}
.tab-item:hover {
  background: rgba(0, 0, 0, 0.05);
}
.tab-item.active {
  background: #fff;
  color: #18a058;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dirty-mark {
  color: #18a058;
  font-weight: bold;
  font-size: 14px;
  flex-shrink: 0;
}
.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: none;
  background: transparent;
  color: #999;
  font-size: 14px;
  line-height: 1;
  border-radius: 3px;
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
}
.close-btn:hover {
  background: rgba(0, 0, 0, 0.1);
  color: #333;
}
.new-tab-btn {
  flex-shrink: 0;
  font-size: 16px;
}
</style>
