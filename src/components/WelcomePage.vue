<script setup lang="ts">
import { computed } from "vue";
import { NEmpty } from "naive-ui";
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

// 三个主操作按钮配置
const primaryActions = [
  { key: "open-folder", label: "打开文件夹", desc: "作为工作区管理 Markdown 文件", icon: "folder", primary: true },
  { key: "open-file", label: "打开文件", desc: "在新标签页中打开单个 Markdown", icon: "file", primary: false },
  { key: "new-file", label: "新建文件", desc: "从空白开始撰写", icon: "plus", primary: false },
] as const;

function onAction(key: string) {
  switch (key) {
    case "open-folder": emit("open-folder"); break;
    case "open-file": emit("open-file"); break;
    case "new-file": emit("new-file"); break;
  }
}
</script>

<template>
  <div class="welcome-page">
    <!-- 背景装饰层：径向紫光 + 噪点 -->
    <div class="bg-decor" aria-hidden="true">
      <div class="bg-glow bg-glow-1"></div>
      <div class="bg-glow bg-glow-2"></div>
      <div class="bg-grid"></div>
    </div>

    <div class="welcome-content">
      <!-- Logo / 标题区 -->
      <header class="welcome-header">
        <div class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 32 32" width="36" height="36" fill="none">
            <defs>
              <linearGradient id="msk-grad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#c084fc"/>
                <stop offset="100%" stop-color="#7e22ce"/>
              </linearGradient>
            </defs>
            <path d="M6 4h14l6 6v18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"
                  fill="url(#msk-grad)"/>
            <path d="M20 4l6 6h-6z" fill="#f3e8ff" opacity="0.85"/>
            <path d="M10 16h12M10 20h12M10 24h7" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>
          </svg>
        </div>
        <h1 class="brand-title">Murasaki</h1>
        <p class="brand-tagline">紫式部 · 轻量级本地 Markdown 编辑器</p>
      </header>

      <!-- 主操作区：三张卡片 -->
      <section class="actions-grid">
        <button
          v-for="act in primaryActions"
          :key="act.key"
          type="button"
          class="action-card"
          :class="{ 'is-primary': act.primary }"
          @click="onAction(act.key)"
        >
          <span class="action-icon" aria-hidden="true">
            <svg v-if="act.icon === 'folder'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
            </svg>
            <svg v-else-if="act.icon === 'file'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </span>
          <span class="action-text">
            <span class="action-label">{{ act.label }}</span>
            <span class="action-desc">{{ act.desc }}</span>
          </span>
        </button>
      </section>

      <!-- 最近打开 -->
      <section class="recent-section">
        <div v-if="recentFolders.length > 0" class="recent-block">
          <h3 class="block-title">
            <span class="block-dot"></span>
            最近打开的文件夹
          </h3>
          <ul class="recent-list">
            <li
              v-for="entry in recentFolders"
              :key="entry.path"
              class="recent-item"
              :title="entry.path"
              @click="emit('open-recent', entry.path, 'folder')"
            >
              <span class="recent-icon recent-icon-folder" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
                </svg>
              </span>
              <div class="item-text">
                <div class="item-name">{{ basename(entry.path) }}</div>
                <div class="item-path">{{ dirname(entry.path) }}</div>
              </div>
              <span class="item-arrow" aria-hidden="true">→</span>
            </li>
          </ul>
        </div>

        <div v-if="recentFiles.length > 0" class="recent-block">
          <h3 class="block-title">
            <span class="block-dot"></span>
            最近打开的文件
          </h3>
          <ul class="recent-list">
            <li
              v-for="entry in recentFiles"
              :key="entry.path"
              class="recent-item"
              :title="entry.path"
              @click="emit('open-recent', entry.path, 'file')"
            >
              <span class="recent-icon recent-icon-file" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                </svg>
              </span>
              <div class="item-text">
                <div class="item-name">{{ basename(entry.path) }}</div>
                <div class="item-path">{{ dirname(entry.path) }}</div>
              </div>
              <span class="item-arrow" aria-hidden="true">→</span>
            </li>
          </ul>
        </div>

        <NEmpty
          v-if="recentFolders.length === 0 && recentFiles.length === 0"
          description="暂无最近打开记录"
          size="small"
          style="margin-top: 24px"
        />
      </section>

      <!-- 底部：版本号 + 设置入口 -->
      <footer class="welcome-footer">
        <span class="version-text">v{{ APP_VERSION }}</span>
        <span class="footer-sep">·</span>
        <a class="settings-link" href="#" @click.prevent="emit('open-settings')">
          设置
        </a>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.welcome-page {
  position: relative;
  height: 100%;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
  background: var(--murasaki-background);
  isolation: isolate;
}

/* === 背景装饰层 === */
.bg-decor {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
}
.bg-glow {
  position: absolute;
  border-radius: 50%;
  filter: blur(80px);
  opacity: 0.55;
  will-change: transform;
}
.bg-glow-1 {
  width: 480px;
  height: 480px;
  top: -160px;
  left: -120px;
  background: radial-gradient(circle, var(--murasaki-purple-300) 0%, transparent 70%);
  animation: glow-drift-1 14s ease-in-out infinite;
}
.bg-glow-2 {
  width: 540px;
  height: 540px;
  bottom: -200px;
  right: -160px;
  background: radial-gradient(circle, var(--murasaki-purple-200) 0%, transparent 70%);
  animation: glow-drift-2 18s ease-in-out infinite;
}
.bg-grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(to right, rgba(147, 51, 234, 0.04) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(147, 51, 234, 0.04) 1px, transparent 1px);
  background-size: 32px 32px;
  -webkit-mask-image: radial-gradient(ellipse at center, #000 30%, transparent 75%);
          mask-image: radial-gradient(ellipse at center, #000 30%, transparent 75%);
}

@keyframes glow-drift-1 {
  0%, 100% { transform: translate(0, 0) scale(1); }
  50% { transform: translate(40px, 60px) scale(1.08); }
}
@keyframes glow-drift-2 {
  0%, 100% { transform: translate(0, 0) scale(1); }
  50% { transform: translate(-50px, -30px) scale(1.12); }
}

/* === 内容容器 === */
.welcome-content {
  position: relative;
  z-index: 1;
  max-width: 640px;
  width: 100%;
  padding: 48px 40px;
  text-align: center;
  animation: murasaki-fade-in var(--murasaki-duration-slow) var(--murasaki-ease-out) both;
}

/* === 品牌头部 === */
.welcome-header {
  margin-bottom: 36px;
  animation: murasaki-fade-in var(--murasaki-duration-slow) var(--murasaki-ease-out) both;
  animation-delay: 60ms;
}
.brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border-radius: var(--murasaki-radius-lg);
  background: linear-gradient(135deg, var(--murasaki-purple-50), var(--murasaki-purple-100));
  border: 1px solid var(--murasaki-purple-200);
  box-shadow:
    0 8px 24px rgba(147, 51, 234, 0.15),
    inset 0 1px 0 rgba(255, 255, 255, 0.6);
  margin-bottom: 16px;
}
.brand-title {
  font-size: 36px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--murasaki-ink);
  margin-bottom: 6px;
  line-height: 1.1;
}
.brand-title::first-letter {
  color: var(--murasaki-primary);
}
.brand-tagline {
  font-size: 13px;
  color: var(--murasaki-ink-3);
  letter-spacing: 0.02em;
}

/* === 操作卡片网格 === */
.actions-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 40px;
  animation: murasaki-fade-in var(--murasaki-duration-slow) var(--murasaki-ease-out) both;
  animation-delay: 140ms;
}
.action-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  padding: 18px 16px 16px;
  text-align: left;
  background: var(--murasaki-background);
  border: 1px solid var(--murasaki-line);
  border-radius: var(--murasaki-radius-md);
  cursor: pointer;
  font-family: inherit;
  position: relative;
  overflow: hidden;
  transition:
    transform var(--murasaki-duration-base) var(--murasaki-ease-out),
    border-color var(--murasaki-duration-fast) var(--murasaki-ease),
    box-shadow var(--murasaki-duration-base) var(--murasaki-ease),
    background var(--murasaki-duration-fast) var(--murasaki-ease);
}
.action-card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, var(--murasaki-purple-50) 0%, transparent 60%);
  opacity: 0;
  transition: opacity var(--murasaki-duration-base) var(--murasaki-ease);
  pointer-events: none;
}
.action-card:hover {
  transform: translateY(-2px);
  border-color: var(--murasaki-purple-300);
  box-shadow: var(--murasaki-shadow-md);
}
.action-card:hover::before {
  opacity: 1;
}
.action-card:active {
  transform: translateY(0);
  box-shadow: var(--murasaki-shadow-sm);
}
.action-card.is-primary {
  background: linear-gradient(135deg, var(--murasaki-purple-600) 0%, var(--murasaki-purple-800) 100%);
  border-color: transparent;
  color: var(--murasaki-primary-foreground);
  box-shadow: var(--murasaki-shadow-purple);
}
.action-card.is-primary::before {
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.18) 0%, transparent 60%);
}
.action-card.is-primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 12px 28px rgba(147, 51, 234, 0.32);
  border-color: transparent;
}
.action-card.is-primary .action-desc {
  color: rgba(255, 255, 255, 0.78);
}
.action-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--murasaki-radius-sm);
  background: var(--murasaki-purple-50);
  color: var(--murasaki-purple-700);
  flex-shrink: 0;
}
.action-card.is-primary .action-icon {
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
}
.action-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.action-label {
  font-size: 14px;
  font-weight: 600;
  color: inherit;
  letter-spacing: -0.01em;
}
.action-desc {
  font-size: 11px;
  color: var(--murasaki-ink-3);
  line-height: 1.4;
}

/* === 最近打开区 === */
.recent-section {
  text-align: left;
  animation: murasaki-fade-in var(--murasaki-duration-slow) var(--murasaki-ease-out) both;
  animation-delay: 220ms;
}
.recent-block {
  margin-bottom: 24px;
}
.recent-block:last-of-type {
  margin-bottom: 0;
}
.block-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--murasaki-ink-3);
  margin-bottom: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.block-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--murasaki-primary);
  flex-shrink: 0;
}
.recent-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.recent-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: var(--murasaki-radius-sm);
  cursor: pointer;
  border: 1px solid transparent;
  transition:
    background var(--murasaki-duration-fast) var(--murasaki-ease),
    border-color var(--murasaki-duration-fast) var(--murasaki-ease),
    transform var(--murasaki-duration-fast) var(--murasaki-ease);
}
.recent-item:hover {
  background: var(--murasaki-purple-50);
  border-color: var(--murasaki-purple-100);
}
.recent-item:hover .item-arrow {
  transform: translateX(3px);
  opacity: 1;
}
.recent-item:active {
  transform: scale(0.99);
}
.recent-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--murasaki-radius-sm);
  flex-shrink: 0;
}
.recent-icon-folder {
  background: var(--murasaki-purple-100);
  color: var(--murasaki-purple-700);
}
.recent-icon-file {
  background: var(--murasaki-surface-2);
  color: var(--murasaki-ink-2);
}
.item-text {
  flex: 1;
  min-width: 0;
}
.item-name {
  font-size: 13px;
  color: var(--murasaki-ink);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-path {
  font-size: 11px;
  color: var(--murasaki-ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 1px;
}
.item-arrow {
  color: var(--murasaki-primary);
  opacity: 0;
  flex-shrink: 0;
  font-size: 14px;
  transition: transform var(--murasaki-duration-fast) var(--murasaki-ease-out),
              opacity var(--murasaki-duration-fast) var(--murasaki-ease);
}

/* === 底部 === */
.welcome-footer {
  margin-top: 40px;
  padding-top: 16px;
  border-top: 1px solid var(--murasaki-line);
  font-size: 12px;
  color: var(--murasaki-ink-3);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.version-text {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
.footer-sep {
  color: var(--murasaki-neutral-300);
}
.settings-link {
  color: var(--murasaki-purple-700);
  text-decoration: none;
  cursor: pointer;
  transition: color var(--murasaki-duration-fast) var(--murasaki-ease);
}
.settings-link:hover {
  color: var(--murasaki-primary);
  text-decoration: underline;
}

/* === 多端适配 === */
/* 窄窗口：3 列 → 1 列 */
@media (max-width: 640px) {
  .welcome-content {
    padding: 32px 20px;
  }
  .actions-grid {
    grid-template-columns: 1fr;
  }
  .brand-title {
    font-size: 30px;
  }
  .brand-mark {
    width: 56px;
    height: 56px;
  }
}

/* 触屏：放大点击区 */
@media (pointer: coarse) {
  .action-card {
    padding: 20px 18px;
  }
  .action-icon {
    width: 36px;
    height: 36px;
  }
  .recent-item {
    padding: 12px 14px;
  }
  .recent-icon {
    width: 32px;
    height: 32px;
  }
}

/* 减弱动效 */
@media (prefers-reduced-motion: reduce) {
  .bg-glow {
    animation: none;
  }
}
</style>
