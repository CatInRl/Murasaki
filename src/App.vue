<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import { storeToRefs } from "pinia";
import {
  NConfigProvider,
} from "naive-ui";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import EditorPane from "./components/EditorPane.vue";
import Sidebar from "./components/Sidebar.vue";
import TabBar from "./components/TabBar.vue";
import WelcomePage from "./components/WelcomePage.vue";
import SearchPanel from "./components/SearchPanel.vue";
import StatusBar from "./components/StatusBar.vue";
import TableInsertDialog from "./components/TableInsertDialog.vue";
import CompareWindow from "./components/CompareWindow.vue";
import ImagePreviewModal from "./components/ImagePreviewModal.vue";
import AgentPanel from "./components/AgentPanel.vue";
import ToastContainer from "./components/ToastContainer.vue";
import DialogContainer from "./components/DialogContainer.vue";
import ContextMenuContainer from "./components/ContextMenuContainer.vue";
import SettingsApp from "./settings/SettingsApp.vue";
import { useWorkspaceStore } from "./stores/useWorkspaceStore";
import { useTabsStore } from "./stores/useTabsStore";
import { usePersistenceStore } from "./stores/usePersistenceStore";
import { useSearchStore } from "./stores/useSearchStore";
import { useFileOpsStore } from "./stores/useFileOpsStore";
import { useAgentStore } from "./stores/useAgentStore";
import { useEditorBridgeStore } from "./stores/useEditorBridgeStore";
import { useProposalsStore } from "./stores/useProposalsStore";
import { useDialogStore } from "./stores/useDialogStore";
import { useFileWatcher } from "./composables/useFileWatcher";
import { useImagePaste } from "./composables/useImagePaste";
import { useRecentMenuSync } from "./composables/useRecentMenuSync";
import { useFileActions } from "./composables/useFileActions";
import { exportHtml } from "./composables/useHtmlExport";
import { useEditorNavigation } from "./composables/useEditorNavigation";
import { useCompareWindow } from "./composables/useCompareWindow";
import { useTabClose } from "./composables/useTabClose";
import { useCommands } from "./composables/useCommands";
import { useAppLifecycle } from "./composables/useAppLifecycle";
import {
  fieldsForCategory,
  isDirty,
  isCategoryDirty,
  restoreCategoryDefaults,
} from "./settings/settingsLogic";
import { basename } from "./utils/path";
import { DEFAULT_THEME } from "./composables/useTheme";
import { useNaiveTheme } from "./composables/useNaiveTheme";
import { undo as cmUndo, redo as cmRedo } from "@codemirror/commands";
import type { SidebarView, SettingsState } from "./types";

const workspace = useWorkspaceStore();
const tabsStore = useTabsStore();
const persistence = usePersistenceStore();
const searchStore = useSearchStore();
const fileOps = useFileOpsStore();
const agentStore = useAgentStore();
const editorBridge = useEditorBridgeStore();
const proposalsStore = useProposalsStore();
const dialog = useDialogStore();

// ===== 主题 =====
const currentTheme = ref(DEFAULT_THEME);

// ===== naive-ui 主题对齐 --murasaki-* token（ADR-0005）=====
// 浅色/深色切换时 naive-ui 组件颜色/圆角/字体跟随 --murasaki-* token 变化
const { theme: naiveTheme, themeOverrides: naiveThemeOverrides } = useNaiveTheme(
  computed(() => persistence.settings.uiMode)
);

// ===== 编辑器引用 =====
const editorRef = ref<InstanceType<typeof EditorPane> | null>(null);

// ===== 当前激活 tab 内容（双向绑定到编辑器） =====
const activeTab = computed(() => tabsStore.activeTab);
const activeContent = computed({
  get: () => activeTab.value?.content ?? "",
  set: (val: string) => {
    if (activeTab.value) {
      tabsStore.updateContent(activeTab.value.id, val);
    }
  },
});

const currentFilePath = computed(() => activeTab.value?.path ?? null);

// 切 tab 时更新 editor bridge 的文档路径（供 agent 工具使用）
// 用 flush: 'post' 确保在 SourceEditor.onMounted（registerView(view, null)）之后触发，
// 否则首次打开 tab 时 EditorPane 挂载会重置 activeDocPath 为 null，
// 导致 agent.hasContext 为 false、上下文卡片不显示。
watch(currentFilePath, (path) => {
  editorBridge.updateDocPath(path);
}, { flush: 'post' });

// ===== 文件操作 composable（磁盘 IO 类入口）=====
const {
  openFile, openFileViaDialog, saveCurrentFile, saveAsCurrentFile,
  reloadCurrentFile, exportCurrentHtml, onNewTab, onNewFile,
  onOpenFolder, onOpenFile, onOpenRecent,
} = useFileActions({ tabsStore, workspace, persistence, dialog, activeTab, currentTheme });

// ===== 对比窗口 + 外部修改处理 composable（三选一对话框改走 dialog store）=====
const {
  compareState,
  handleExternalChange,
  onCompareSave, onCompareUseExternal, onCompareClose,
} = useCompareWindow({ tabsStore, dialog });

// ===== Tab 关闭逻辑 composable（对话框改走 dialog store）=====
const {
  onCloseTabRequest, onCloseOthers, onCloseRight, onCloseLeft, onCloseAllTabs,
} = useTabClose({ tabsStore, agentStore, dialog, workspace });

// ===== 侧栏视图（受控） =====
const sidebarView = ref<SidebarView>("files");

// ===== 状态栏 / 全屏 =====
const statusBarVisible = ref(true);
const isFullscreen = ref(false);

// ===== 光标位置与字数统计 =====
const cursorLine = ref(1);
const cursorCol = ref(0);
/** 字符数（不含空格的 Unicode 字符数，与 spec 一致） */
const charCount = computed(() => {
  const text = activeContent.value;
  let count = 0;
  for (const ch of text) {
    // 跳过空白字符（空格、tab、换行等）
    if (!/\s/.test(ch)) count++;
  }
  return count;
});
/** 字数（按 Unicode 字符统计，与 spec 中"字数统计按 Unicode 字符（不含空格）"一致） */
const wordCount = computed(() => charCount.value);

function onCursorChange(payload: { line: number; ch: number }) {
  cursorLine.value = payload.line;
  cursorCol.value = payload.ch;
}

// ===== 冲突对话框（改走 dialog store，不再使用 ConflictDialog 组件）=====
/**
 * 弹出冲突对话框，返回用户选择的动作。
 * 委托给 dialog.conflict()，由 DialogContainer 统一渲染。
 */
function askConflict(
  targetPath: string,
  operation: "rename" | "copy" | "save-as",
  sourcePath?: string
): Promise<{
  action: "overwrite" | "rename" | "cancel";
  newName?: string;
}> {
  return dialog.conflict({
    filename: basename(targetPath),
    sourcePath,
    operation,
  });
}

// ===== 表格插入对话框 =====
const tableDialogVisible = ref(false);

// ===== 图片预览弹窗 =====
const imagePreviewVisible = ref(false);
const imagePreviewPath = ref<string | null>(null);

function onPreviewImage(path: string): void {
  imagePreviewPath.value = path;
  imagePreviewVisible.value = true;
}

// ===== 收起 Agent 面板 =====
async function onCollapseAgentPanel(): Promise<void> {
  await persistence.updateSettings({ showAgentPanel: false } as Partial<SettingsState>);
}

// ===== 设置页（单入口路由，在主窗口内通过 navigate 事件切换） =====
const settingsVisible = ref(false);

async function openSettings(): Promise<void> {
  try {
    await invoke("open_settings");
  } catch (err) {
    console.error("打开设置窗口失败:", err);
    dialog.alert({ message: `打开设置窗口失败: ${err}`, variant: "error" });
  }
}

// ===== 启动初始化 =====
// 事件监听器 cleanup（由 setupEventListeners 在 onMounted 中赋值）
let cleanupListeners: (() => void) | null = null;

onMounted(async () => {
  // 1. 加载持久化状态
  await persistence.loadSettings();
  await persistence.loadRecent();

  // 应用保存的主题
  if (persistence.settings.markdownTheme) {
    currentTheme.value = persistence.settings.markdownTheme;
  }
  // 应用保存的编辑模式（运行时切换，无需重启）
  editorBridge.setEditorMode(persistence.settings.editorMode);
  // 恢复侧栏视图
  if (persistence.settings.sidebarView) {
    sidebarView.value = persistence.settings.sidebarView;
  }
  // 恢复上次打开的工作区
  if (persistence.settings.lastWorkspacePath) {
    try {
      await workspace.openWorkspace(persistence.settings.lastWorkspacePath);
    } catch (err) {
      console.warn("恢复工作区失败:", err);
    }
  }

  // 2. 恢复上次打开的 tabs
  await tabsStore.restore();

  // 3. 注册 5 个 tauri 事件监听器（menu-event / recent-open / single-instance / settings://saved / navigate）
  cleanupListeners = await setupEventListeners();

  // 4. 同步最近打开菜单到原生菜单
  await syncRecentMenu();

  // 5. 注册全局快捷键
  window.addEventListener("keydown", onKeyDown);

  // 6. 启动文件监听（外部修改检测）
  fileWatcher.start();

  // 7. 注册图片粘贴处理（监听编辑器宿主元素的 paste 事件）
  imagePaste.setup();

  // 8. 注入冲突解决器给 fileOps store（供文件树右键菜单使用）
  fileOps.setConflictResolver(askConflict);

  // 9. 注入新文件提议的冲突解决器（Ticket #24b: propose_new_file 复用 T2 ConflictDialog）
  //     operation 使用 "save-as"，因为 agent 创建新文件相当于另存为新路径
  proposalsStore.setNewFileConflictResolver((targetPath: string) =>
    askConflict(targetPath, "save-as")
  );

  // 10. 检测孤儿对话（Ticket #25: workspace 已删除但对话文件残留）
  //     若存在孤儿，在控制台提示（后续可扩展到状态栏提示 + 一键清理）
  try {
    const orphanCount = await agentStore.checkOrphanChats();
    if (orphanCount > 0) {
      console.warn(`[Murasaki] 检测到 ${orphanCount} 个孤儿对话，可通过状态栏手动清理`);
    }
  } catch (err) {
    console.warn("检测孤儿对话失败:", err);
  }

  initialized.value = true;

  // E2E 测试辅助：暴露 editorRef + test hooks 到 window
  // 桌面应用 WebView 内部仅应用代码可访问，无 XSS 风险
  // 测试通过 window.__editorRef__.getView() 直接调用 CodeMirror API
  // 注意：editorRef 是 Vue ref，EditorPane 用 v-else 渲染（无 tab 时不挂载）
  // 所以必须用动态 getter，否则 onMounted 时 editorRef.value 还是 null
  // 同时暴露 undo/redo：release 构建后浏览器内 dynamic import 路径不可用
  // @ts-ignore
  window.__editorRef__ = {
    getView: () => editorRef.value?.getView() ?? null,
    scrollToLine: (line: number) => editorRef.value?.scrollToLine(line),
    focus: () => editorRef.value?.focus(),
    undo: () => {
      const view = editorRef.value?.getView();
      if (view) { view.focus(); cmUndo(view); }
    },
    redo: () => {
      const view = editorRef.value?.getView();
      if (view) { view.focus(); cmRedo(view); }
    },
  };
  // E2E test hooks：release 构建后 dynamic import 不可用，暴露纯函数/设置器供测试调用
  // @ts-ignore
  window.__exportHtml__ = exportHtml;
  // @ts-ignore
  window.__setTheme__ = (theme: string) => { currentTheme.value = theme; };
  // @ts-ignore
  window.__setSidebarView__ = (view: SidebarView) => { sidebarView.value = view; };
  // 暴露 settingsLogic 纯函数：设置窗口未打开时主窗口也能被 E2E 测试访问到
  // @ts-ignore
  window.__settingsLogic__ = {
    fieldsForCategory,
    isDirty,
    isCategoryDirty,
    restoreCategoryDefaults,
  };
});

onBeforeUnmount(() => {
  // 清理 5 个 tauri 事件监听器
  cleanupListeners?.();
  cleanupListeners = null;
  window.removeEventListener("keydown", onKeyDown);
  fileWatcher.stop();
  imagePaste.teardown();
  fileOps.setConflictResolver(null);
  proposalsStore.setNewFileConflictResolver(null);
  // 刷新待保存的对话到磁盘（Ticket #25）
  void agentStore.saveChatDebounced.flush();
});

// ===== 文件监听（外部修改检测） =====
// 串行队列：确保同时只有一个外部修改弹窗
let externalChangeChain: Promise<void> = Promise.resolve();

const fileWatcher = useFileWatcher({
  onExternalChange: (path: string) => {
    externalChangeChain = externalChangeChain
      .catch(() => {})
      .then(() => handleExternalChange(path))
      .catch((err) => console.error("处理外部修改失败:", err));
    return externalChangeChain;
  },
});

// ===== 图片粘贴/拖入处理 =====
const imagePaste = useImagePaste({
  getEditorView: () => editorRef.value?.getView() ?? null,
  getWorkspacePath: () => workspace.workspacePath,
  getCurrentFilePath: () => activeTab.value?.path ?? null,
});

// ===== 编辑器导航/插入 composable =====
const {
  onJumpToLine, onSearchSelectFile, onDropImagePath,
  onEditorContextAction, onTableInsertConfirm,
} = useEditorNavigation({ editorRef, openFile, imagePaste, tableDialogVisible, dialog });

// ===== 全屏切换 =====
async function toggleFullscreen(): Promise<void> {
  try {
    const win = getCurrentWebviewWindow();
    const newIsFull = !isFullscreen.value;
    if (newIsFull) {
      await win.setFullscreen(true);
      isFullscreen.value = true;
      // 全屏时自动隐藏状态栏（spec 要求）
      statusBarVisible.value = false;
    } else {
      await win.setFullscreen(false);
      isFullscreen.value = false;
      // 退出全屏时恢复状态栏
      statusBarVisible.value = true;
    }
  } catch (err) {
    console.error("切换全屏失败:", err);
  }
}

// ===== 命令分发（菜单事件 + 全局快捷键）=====
const { handleMenuEvent, onKeyDown } = useCommands({
  onNewTab, openFileViaDialog, saveCurrentFile, saveAsCurrentFile,
  reloadCurrentFile, exportCurrentHtml,
  onCloseTabRequest,
  workspace, tabsStore, searchStore, fileOps, dialog,
  editorRef, currentTheme, sidebarView, statusBarVisible,
  tableDialogVisible,
  openSettings, toggleFullscreen,
});

// ===== 应用生命周期（5 watcher + 5 事件监听器）=====
const { initialized, setupEventListeners } = useAppLifecycle({
  tabsStore,
  persistence,
  workspace,
  editorBridge,
  proposalsStore,
  currentTheme,
  sidebarView,
  settingsVisible,
  handleMenuEvent,
  onOpenRecent,
});

// ===== 最近打开菜单同步（debounce + in-flight 锁，watcher 自启动）=====
const { recentEntries: recentEntriesRef } = storeToRefs(persistence);
const { syncNow: syncRecentMenu } = useRecentMenuSync({
  persistence: {
    recentEntries: recentEntriesRef,
    getRecentFolders: persistence.getRecentFolders,
    getRecentFiles: persistence.getRecentFiles,
  },
  initialized,
});

</script>

<template>
  <NConfigProvider :theme="naiveTheme" :theme-overrides="naiveThemeOverrides" :locale="null" :date-locale="null">
    <div class="murasaki-shell" :class="{ 'has-sidebar': workspace.hasWorkspace || tabsStore.hasTabs }">
      <!-- Sidebar: 文件树 / 大纲 -->
      <aside
        v-if="workspace.hasWorkspace || tabsStore.hasTabs"
        class="murasaki-sidebar"
      >
        <Sidebar
          :current-file-path="currentFilePath"
          :active-view="sidebarView"
          :has-workspace="workspace.hasWorkspace"
          @select-file="openFile"
          @jump-to-line="onJumpToLine"
          @preview-image="onPreviewImage"
          @update:active-view="(v) => (sidebarView = v)"
        />
      </aside>

      <!-- 主区域 -->
      <div class="main-area">
        <!-- 顶部：Tab 栏 -->
        <div class="top-bar">
          <TabBar
            v-if="tabsStore.hasTabs"
            class="tab-bar-slot"
            @new-tab="onNewTab"
            @close-tab="onCloseTabRequest"
            @close-others="onCloseOthers"
            @close-right="onCloseRight"
            @close-left="onCloseLeft"
            @close-all="onCloseAllTabs"
          />
          <div v-else class="top-bar-title">
            <span class="app-brand-dot"></span>
            <span class="app-name">Murasaki</span>
          </div>
        </div>

        <!-- 内容区：欢迎页 或 编辑器 + 底部搜索面板 -->
        <div class="content-area">
          <WelcomePage
            v-if="!tabsStore.hasTabs"
            @open-folder="onOpenFolder"
            @open-file="onOpenFile"
            @new-file="onNewFile"
            @open-recent="onOpenRecent"
            @open-settings="openSettings"
          />
          <EditorPane
            v-else
            ref="editorRef"
            v-model="activeContent"
            :tab-id="tabsStore.activeTabId"
            :split-ratio="0.5"
            :show-line-numbers="persistence.settings.showLineNumbers"
            :soft-wrap="persistence.settings.softWrap"
            :preview-theme="currentTheme"
            :current-file-path="currentFilePath"
            :workspace-path="workspace.workspacePath"
            :editor-mode="editorBridge.editorMode"
            :font-size="persistence.settings.editorFontSize"
            :line-height="persistence.settings.editorLineHeight"
            :font-family="persistence.settings.editorFontFamily"
            @cursor-change="onCursorChange"
            @open-internal="openFile"
            @drop-image-path="onDropImagePath"
            @context-action="onEditorContextAction"
          />

          <!-- 底部：跨文件搜索面板 -->
          <SearchPanel
            v-if="searchStore.visible"
            class="search-panel-slot"
            @select-file="onSearchSelectFile"
            @close="searchStore.visible = false"
          />
        </div>

        <!-- 状态栏 -->
        <StatusBar
          v-if="statusBarVisible"
          :file-path="currentFilePath"
          :cursor-line="cursorLine"
          :cursor-col="cursorCol"
          :char-count="charCount"
          :word-count="wordCount"
          :agent-running="agentStore.isThinking"
        />
      </div>

      <!-- Agent 面板 -->
      <AgentPanel
        v-if="persistence.settings.showAgentPanel"
        @collapse="onCollapseAgentPanel"
        @open-folder-dialog="onOpenFolder"
        @open-settings="openSettings"
      />
    </div>

    <!-- 右键菜单容器（全局唯一，数据驱动） -->
    <ContextMenuContainer />

    <!-- 设置页（单入口路由，覆盖主窗口） -->
    <SettingsApp v-if="settingsVisible" @close="settingsVisible = false" />

    <!-- 对话框容器（Ticket #66，含 conflict/alert/confirm/prompt/unsaved 五类） -->
    <DialogContainer />

    <!-- 插入表格对话框 -->
    <TableInsertDialog
      :visible="tableDialogVisible"
      @confirm="onTableInsertConfirm"
      @cancel="tableDialogVisible = false"
    />

    <!-- 对比窗口（外部修改合并） -->
    <CompareWindow
      :visible="compareState.visible"
      :file-path="compareState.filePath"
      :external-content="compareState.externalContent"
      :local-content="compareState.localContent"
      @close="onCompareClose"
      @save="onCompareSave"
      @use-external="onCompareUseExternal"
    />

    <!-- 图片预览弹窗 -->
    <ImagePreviewModal
      :visible="imagePreviewVisible"
      :path="imagePreviewPath"
      @close="imagePreviewVisible = false"
    />

    <!-- 外部修改三选一 / Agent 运行中关闭 / 冲突 / 未保存改动 均由 DialogContainer 统一渲染 -->
    <ToastContainer />
  </NConfigProvider>
</template>

<style>
/* === Murasaki App Shell Layout === */
.murasaki-shell {
  display: flex;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
  background: var(--murasaki-background);
}

.murasaki-shell.has-sidebar .murasaki-sidebar {
  width: var(--murasaki-sidebar-width);
  flex-shrink: 0;
  border-right: 1px solid var(--murasaki-line);
  background: var(--murasaki-surface);
  overflow: hidden;
  transition: width var(--murasaki-duration-base) var(--murasaki-ease);
}

.main-area {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  background: var(--murasaki-background);
}

.content-area {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}

.search-panel-slot {
  height: 240px;
  flex-shrink: 0;
  border-top: 1px solid var(--murasaki-line);
  animation: murasaki-slide-up var(--murasaki-duration-base) var(--murasaki-ease-out);
}

@keyframes murasaki-slide-up {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.top-bar {
  height: var(--murasaki-topbar-height);
  padding: 0 10px;
  border-bottom: 1px solid var(--murasaki-line);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--murasaki-surface);
  user-select: none;
}

.tab-bar-slot {
  flex: 1;
  min-width: 0;
  height: 100%;
  transition: opacity var(--murasaki-duration-fast) var(--murasaki-ease);
}

.top-bar-title {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 4px;
}

.app-brand-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--murasaki-purple-400), var(--murasaki-purple-700));
  box-shadow: 0 0 0 3px rgba(147, 51, 234, 0.12);
  flex-shrink: 0;
  animation: murasaki-pulse-soft 3.2s ease-in-out infinite;
}

.app-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--murasaki-primary);
  letter-spacing: -0.01em;
}

/* === Naive UI overrides for purple brand === */
:deep(.n-base-selection) .n-base-selection__border,
:deep(.n-base-selection) .n-base-selection__state-border {
  --n-border: 1px solid var(--murasaki-border) !important;
}

/* === Multi-end adaptation === */
/* 紧凑密度：窄窗口 */
@media (max-width: 980px) {
  .top-bar {
    padding: 0 6px;
    gap: 4px;
  }
}

/* 极窄窗口：进一步压缩 */
@media (max-width: 720px) {
  .top-bar {
    padding: 0 4px;
    gap: 2px;
  }
}

/* 触屏：放大顶栏 */
@media (pointer: coarse) {
  .top-bar {
    height: 40px;
  }
}

/* 高 DPI 字体优化 */
@media (-webkit-min-device-pixel-ratio: 2), (min-resolution: 192dpi) {
  .app-name {
    -webkit-font-smoothing: subpixel-antialiased;
  }
}
</style>
