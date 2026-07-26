<script setup lang="ts">
import { computed } from "vue";
import { NButton, NEmpty } from "naive-ui";
import { usePersistenceStore } from "../stores/usePersistenceStore";
import { basename, dirname } from "../utils/path";

const persistence = usePersistenceStore();

const emit = defineEmits<{
  (e: "open-folder"): void;
  (e: "open-file"): void;
  (e: "new-file"): void;
  (e: "open-recent", path: string, type: "file" | "folder"): void;
  (e: "open-settings"): void;
}>();

// 应用版本（与 package.json / tauri.conf.json 保持一致）
const APP_VERSION = "0.1.0";

const recentFolders = computed(() => persistence.getRecentFolders(5));
const recentFiles = computed(() => persistence.getRecentFiles(5));
</script>

<template>
  <div class="welcome-page">
    <div class="welcome-content">
      <!-- Logo / 标题 -->
      <div class="welcome-header">
        <h1 class="title">Murasaki</h1>
        <p class="subtitle">轻量级 Markdown 编辑器</p>
      </div>

      <!-- 操作按钮 -->
      <div class="actions">
        <NButton size="large" type="primary" @click="emit('open-folder')">
          打开文件夹
        </NButton>
        <NButton size="large" @click="emit('open-file')">
          打开文件
        </NButton>
        <NButton size="large" quaternary @click="emit('new-file')">
          新建文件
        </NButton>
      </div>

      <!-- 最近打开 -->
      <div class="recent-section">
        <div v-if="recentFolders.length > 0" class="recent-block">
          <h3 class="block-title">最近打开的文件夹</h3>
          <ul class="recent-list">
            <li
              v-for="entry in recentFolders"
              :key="entry.path"
              class="recent-item"
              :title="entry.path"
              @click="emit('open-recent', entry.path, 'folder')"
            >
              <span class="item-icon">📁</span>
              <div class="item-text">
                <div class="item-name">{{ basename(entry.path) }}</div>
                <div class="item-path">{{ dirname(entry.path) }}</div>
              </div>
            </li>
          </ul>
        </div>

        <div v-if="recentFiles.length > 0" class="recent-block">
          <h3 class="block-title">最近打开的文件</h3>
          <ul class="recent-list">
            <li
              v-for="entry in recentFiles"
              :key="entry.path"
              class="recent-item"
              :title="entry.path"
              @click="emit('open-recent', entry.path, 'file')"
            >
              <span class="item-icon">📄</span>
              <div class="item-text">
                <div class="item-name">{{ basename(entry.path) }}</div>
                <div class="item-path">{{ dirname(entry.path) }}</div>
              </div>
            </li>
          </ul>
        </div>

        <NEmpty
          v-if="recentFolders.length === 0 && recentFiles.length === 0"
          description="暂无最近打开记录"
          size="small"
          style="margin-top: 24px"
        />
      </div>

      <!-- 底部：版本号 + 设置入口 -->
      <div class="welcome-footer">
        <span class="version-text">v{{ APP_VERSION }}</span>
        <span class="footer-sep">·</span>
        <a class="settings-link" href="#" @click.prevent="emit('open-settings')">
          设置
        </a>
      </div>
    </div>
  </div>
</template>

<style scoped>
.welcome-page {
  height: 100%;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #fafafa 0%, #f0f0f5 100%);
  overflow: auto;
}
.welcome-content {
  max-width: 600px;
  width: 100%;
  padding: 40px;
  text-align: center;
}
.welcome-header {
  margin-bottom: 40px;
}
.title {
  font-size: 48px;
  font-weight: 300;
  color: #333;
  margin-bottom: 8px;
  letter-spacing: 2px;
}
.subtitle {
  font-size: 14px;
  color: #999;
}
.actions {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin-bottom: 48px;
  flex-wrap: wrap;
}
.recent-section {
  text-align: left;
}
.recent-block {
  margin-bottom: 24px;
}
.block-title {
  font-size: 13px;
  font-weight: 600;
  color: #666;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.recent-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.recent-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.1s;
}
.recent-item:hover {
  background: rgba(0, 0, 0, 0.04);
}
.item-icon {
  font-size: 18px;
  flex-shrink: 0;
}
.item-text {
  flex: 1;
  min-width: 0;
}
.item-name {
  font-size: 13px;
  color: #333;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-path {
  font-size: 11px;
  color: #999;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.welcome-footer {
  margin-top: 48px;
  padding-top: 16px;
  border-top: 1px solid #eee;
  font-size: 12px;
  color: #999;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.version-text {
  font-variant-numeric: tabular-nums;
}
.footer-sep {
  color: #ddd;
}
.settings-link {
  color: #666;
  text-decoration: none;
  cursor: pointer;
}
.settings-link:hover {
  color: #18a058;
  text-decoration: underline;
}
</style>
