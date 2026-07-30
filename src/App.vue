<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import {
  NConfigProvider,
  NModal,
  NButton,
  NSpace,
  NText,
} from "naive-ui";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import EditorPane from "./components/EditorPane.vue";
import Sidebar from "./components/Sidebar.vue";
import TabBar from "./components/TabBar.vue";
import WelcomePage from "./components/WelcomePage.vue";
import SearchPanel from "./components/SearchPanel.vue";
import StatusBar from "./components/StatusBar.vue";
import ConflictDialog from "./components/ConflictDialog.vue";
import TableInsertDialog from "./components/TableInsertDialog.vue";
import CompareWindow from "./components/CompareWindow.vue";
import ImagePreviewModal from "./components/ImagePreviewModal.vue";
import AgentPanel from "./components/AgentPanel.vue";
import ToastContainer from "./components/ToastContainer.vue";
import DialogContainer from "./components/DialogContainer.vue";
import ContextMenuContainer from "./components/ContextMenuContainer.vue";
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
import { DEFAULT_THEME } from "./composables/useTheme";
import { useNaiveTheme } from "./composables/useNaiveTheme";
import {
  setHeading,
  toggleList,
  toggleCodeBlock,
  toggleBlockquote,
  insertHorizontalRule,
  insertTable,
} from "./composables/useEditorCommands";
import { exportHtml } from "./composables/useHtmlExport";
import { undo as cmUndo, redo as cmRedo } from "@codemirror/commands";
import { basename } from "./utils/path";
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

// ===== 冲突对话框 =====
const conflictState = ref<{
  visible: boolean;
  targetPath: string;
  sourcePath?: string;
  operation: "rename" | "copy" | "save-as";
}>({ visible: false, targetPath: "", operation: "rename" });

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

// ===== 打开设置窗口（Tauri 多窗口，见 ADR-0009） =====
async function openSettings(): Promise<void> {
  try {
    await invoke("open_settings");
  } catch (err) {
    console.error("打开设置窗口失败:", err);
    dialog.alert({ message: `打开设置窗口失败: ${err}`, variant: "error" });
  }
}

// ===== 对比窗口（外部修改合并） =====
const compareState = ref<{
  visible: boolean;
  filePath: string;
  externalContent: string;
  localContent: string;
}>({ visible: false, filePath: "", externalContent: "", localContent: "" });

// ===== 最近打开菜单同步 =====
// 使用 debounce + in-flight 标记避免并发触发与重复重建菜单
let syncRecentMenuTimer: ReturnType<typeof setTimeout> | null = null;
let syncRecentMenuInFlight = false;
let syncRecentMenuScheduled = false;

/** 将最近打开的文件夹/文件路径同步到原生菜单的 "最近打开" 子菜单 */
async function syncRecentMenu(): Promise<void> {
  if (syncRecentMenuInFlight) {
    // 已有调用进行中：标记需要在它完成后再次同步（取最新状态）
    syncRecentMenuScheduled = true;
    return;
  }
  syncRecentMenuInFlight = true;
  try {
    do {
      syncRecentMenuScheduled = false;
      const folders = persistence.getRecentFolders(5).map((e) => e.path);
      const files = persistence.getRecentFiles(5).map((e) => e.path);
      try {
        await invoke("update_recent_menu", { folders, files });
      } catch (err) {
        console.warn("更新最近打开菜单失败:", err);
        return;
      }
    } while (syncRecentMenuScheduled);
  } finally {
    syncRecentMenuInFlight = false;
  }
}

/** debounced 版本：合并短时间内连续的 recentEntries 变化（避免频繁重建菜单） */
function scheduleSyncRecentMenu(): void {
  if (syncRecentMenuTimer) clearTimeout(syncRecentMenuTimer);
  syncRecentMenuTimer = setTimeout(() => {
    syncRecentMenuTimer = null;
    if (initialized.value) void syncRecentMenu();
  }, 150);
}

function resolveConflict(payload: {
  action: "overwrite" | "rename" | "cancel";
  newName?: string;
}): void {
  const { targetPath, operation, sourcePath } = conflictState.value;
  conflictState.value = { visible: false, targetPath: "", operation: "rename" };
  conflictResolver?.({ ...payload, targetPath, operation, sourcePath });
}

let conflictResolver: ((res: {
  action: "overwrite" | "rename" | "cancel";
  newName?: string;
  targetPath: string;
  operation: "rename" | "copy" | "save-as";
  sourcePath?: string;
}) => void) | null = null;

/**
 * 弹出冲突对话框，返回用户选择的动作
 */
function askConflict(
  targetPath: string,
  operation: "rename" | "copy" | "save-as",
  sourcePath?: string
): Promise<{
  action: "overwrite" | "rename" | "cancel";
  newName?: string;
}> {
  return new Promise((resolve) => {
    conflictState.value = { visible: true, targetPath, operation, sourcePath };
    conflictResolver = (res) => {
      conflictResolver = null;
      resolve({ action: res.action, newName: res.newName });
    };
  });
}

// ===== 启动初始化 =====
let unlistenMenu: UnlistenFn | null = null;
let unlistenRecentOpen: UnlistenFn | null = null;
let unlistenSingleInstance: UnlistenFn | null = null;
let unlistenSettingsSaved: UnlistenFn | null = null;
let initialized = ref(false);

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

  // 3. 监听菜单事件
  unlistenMenu = await listen<string>("menu-event", (event) => {
    void handleMenuEvent(event.payload);
  });

  // 4. 监听 "最近打开" 子菜单点击事件（payload 携带 path 与 type）
  // Rust 端直接发送类型信息，避免前端反查 recentEntries 时的竞态
  unlistenRecentOpen = await listen<{ path: string; type: "file" | "folder" }>(
    "recent-open",
    (event) => {
      const { path, type } = event.payload;
      void onOpenRecent(path, type);
    }
  );

  // 4b. 监听单实例事件：第二个实例启动时携带工作区路径，在当前实例中打开
  unlistenSingleInstance = await listen<string>(
    "single-instance-open-workspace",
    (event) => {
      const workspacePath = event.payload;
      if (workspacePath) {
        void workspace.openWorkspace(workspacePath);
      }
    }
  );

  // 4c. 监听设置窗口的保存事件（多窗口通信，见 ADR-0009）
  // 设置变更的副作用由 T8.2/T8.3 实现，此处先用 console.log 占位
  unlistenSettingsSaved = await listen<unknown>("settings://saved", (event) => {
    console.log("[settings] 收到设置保存事件:", event.payload);
  });

  // 5. 同步最近打开菜单到原生菜单
  await syncRecentMenu();

  // 6. 注册全局快捷键
  window.addEventListener("keydown", onKeyDown);

  // 7. 启动文件监听（外部修改检测）
  fileWatcher.start();

  // 8. 注册图片粘贴处理（监听编辑器宿主元素的 paste 事件）
  imagePaste.setup();

  // 9. 注入冲突解决器给 fileOps store（供文件树右键菜单使用）
  fileOps.setConflictResolver(askConflict);

  // 10. 注入新文件提议的冲突解决器（Ticket #24b: propose_new_file 复用 T2 ConflictDialog）
  //     operation 使用 "save-as"，因为 agent 创建新文件相当于另存为新路径
  proposalsStore.setNewFileConflictResolver((targetPath: string) =>
    askConflict(targetPath, "save-as")
  );

  // 11. 检测孤儿对话（Ticket #25: workspace 已删除但对话文件残留）
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

  // E2E 测试辅助：暴露 editorRef 到 window
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
});

onBeforeUnmount(() => {
  if (unlistenMenu) {
    unlistenMenu();
    unlistenMenu = null;
  }
  if (unlistenRecentOpen) {
    unlistenRecentOpen();
    unlistenRecentOpen = null;
  }
  if (unlistenSingleInstance) {
    unlistenSingleInstance();
    unlistenSingleInstance = null;
  }
  if (unlistenSettingsSaved) {
    unlistenSettingsSaved();
    unlistenSettingsSaved = null;
  }
  window.removeEventListener("keydown", onKeyDown);
  fileWatcher.stop();
  imagePaste.teardown();
  fileOps.setConflictResolver(null);
  proposalsStore.setNewFileConflictResolver(null);
  // 刷新待保存的对话到磁盘（Ticket #25）
  void agentStore.saveChatDebounced.flush();
});

// ===== Tab 状态变化时持久化 =====
watch(
  () => [tabsStore.tabs, tabsStore.activeTabId],
  () => {
    if (initialized.value) {
      void tabsStore.persist();
    }
  },
  { deep: true }
);

// 主题变化时保存
watch(currentTheme, (newTheme) => {
  if (initialized.value) {
    void persistence.updateSettings({ markdownTheme: newTheme });
  }
});

// 最近打开记录变化时同步原生菜单（debounced，避免频繁重建）
watch(() => persistence.recentEntries, scheduleSyncRecentMenu, { deep: true });

// 侧栏视图变化时保存
watch(sidebarView, (v) => {
  if (initialized.value) {
    void persistence.updateSettings({ sidebarView: v });
  }
});

// 编辑模式设置变更 -> 运行时同步到当前编辑器（无需重启）
watch(() => persistence.settings.editorMode, (mode) => {
  editorBridge.setEditorMode(mode);
});

// 工作区变化时保存（关闭工作区或切换工作区）
watch(() => workspace.workspacePath, (p) => {
  if (initialized.value) {
    void persistence.updateSettings({ lastWorkspacePath: p });
    // 工作区切换时清空所有提议（包括新文件提议）
    // 避免上一个工作区的提议残留导致写入到错误的工作区
    proposalsStore.clearAllForWorkspace();
  }
});

// ===== 文件监听（外部修改检测） =====
// 串行队列：确保同时只有一个 askExternalChange 弹窗
// 否则并发触发会导致 externalChangeState 被覆盖，旧 Promise 永久悬挂
let externalChangeChain: Promise<void> = Promise.resolve();

const fileWatcher = useFileWatcher({
  onExternalChange: (path: string) => {
    // 串行化：每个事件排队等待前一个处理完
    externalChangeChain = externalChangeChain
      .catch(() => {})
      .then(() => handleExternalChange(path))
      .catch((err) => console.error("处理外部修改失败:", err));
    return externalChangeChain;
  },
});

async function handleExternalChange(path: string): Promise<void> {
  const tab = tabsStore.getTabByPath(path);
  if (!tab) return;
  // 读取当前 mtime
  const mtime = await invoke<number>("get_file_mtime", { path }).catch(() => null);
  if (mtime === null) {
    // 文件被外部删除
    tabsStore.markExternalChange(path, true);
    if (!tab.isDirty) {
      dialog.alert({ message: `文件已被外部删除：${path}`, variant: "warning" });
    } else {
      dialog.alert({ message: `文件已被外部删除（草稿已保留）：${path}`, variant: "warning" });
    }
    return;
  }
  if (!tab.isDirty) {
    // 无本地修改：自动重载（store action 处理 content/mtime/dirty/external 标记）
    await tabsStore.reloadFromDisk(path);
    return;
  }
  // 有本地修改：弹出三选一对话框（此时串行队列保证不会并发弹窗）
  const externalContent = await invoke<string>("read_text_file", { path });
  const choice = await askExternalChange(path, externalContent, tab.content);
  if (choice === "load-disk") {
    await tabsStore.applyExternalResolution(path, "load-disk", externalContent);
  } else if (choice === "keep-local") {
    await tabsStore.applyExternalResolution(path, "keep-local");
  } else if (choice === "compare") {
    // 打开对比窗口
    compareState.value = {
      visible: true,
      filePath: path,
      externalContent,
      localContent: tab.content,
    };
  }
}

/**
 * 外部修改冲突的三选一对话框
 * 返回值：load-disk | keep-local | compare
 *
 * 通过自定义模态框实现，提供三个互斥动作。
 */
const externalChangeState = ref<{
  visible: boolean;
  filePath: string;
  resolver: ((res: "load-disk" | "keep-local" | "compare") => void) | null;
}>({ visible: false, filePath: "", resolver: null });

function askExternalChange(
  filePath: string,
  _externalContent: string,
  _localContent: string
): Promise<"load-disk" | "keep-local" | "compare"> {
  const fileName = basename(filePath);
  return new Promise((resolve) => {
    externalChangeState.value = {
      visible: true,
      filePath: fileName,
      resolver: resolve,
    };
  });
}

function onExternalChangeChoice(
  choice: "load-disk" | "keep-local" | "compare"
): void {
  const resolver = externalChangeState.value.resolver;
  externalChangeState.value = {
    visible: false,
    filePath: "",
    resolver: null,
  };
  if (resolver) resolver(choice);
}

/**
 * 对比窗口：保存合并结果（写回磁盘 + 更新 tab 状态）
 */
async function onCompareSave(mergedContent: string): Promise<void> {
  const { filePath } = compareState.value;
  try {
    await tabsStore.writeMergedContent(filePath, mergedContent);
  } catch (err) {
    console.error("保存合并结果失败:", err);
    dialog.alert({ message: `保存合并结果失败: ${err}`, variant: "error" });
  }
  compareState.value = { ...compareState.value, visible: false };
}

/**
 * 对比窗口：放弃本地修改，使用磁盘版本
 */
async function onCompareUseExternal(externalContent: string): Promise<void> {
  const { filePath } = compareState.value;
  await tabsStore.applyExternalResolution(filePath, "load-disk", externalContent);
  compareState.value = { ...compareState.value, visible: false };
}

/**
 * 对比窗口：取消（标记外部修改待处理）
 */
function onCompareClose(): void {
  const { filePath } = compareState.value;
  tabsStore.markExternalChange(filePath, true);
  compareState.value = { ...compareState.value, visible: false };
}

// ===== 图片粘贴/拖入处理 =====
const imagePaste = useImagePaste({
  getEditorView: () => editorRef.value?.getView() ?? null,
  getWorkspacePath: () => workspace.workspacePath,
  getCurrentFilePath: () => activeTab.value?.path ?? null,
});

// ===== 全局快捷键 =====
function onKeyDown(e: KeyboardEvent): void {
  const ctrl = e.ctrlKey || e.metaKey;
  // Ctrl+W：关闭当前 tab
  if (ctrl && e.key === "w" && !e.shiftKey) {
    e.preventDefault();
    if (tabsStore.activeTabId) {
      void onCloseTabRequest(tabsStore.activeTabId);
    }
    return;
  }
  // Ctrl+Tab：切换到下一个 tab
  if (ctrl && e.key === "Tab" && !e.shiftKey) {
    e.preventDefault();
    tabsStore.switchNext();
    return;
  }
  // Ctrl+Shift+Tab：切换到上一个 tab
  if (ctrl && e.shiftKey && e.key === "Tab") {
    e.preventDefault();
    tabsStore.switchPrev();
    return;
  }
  // Ctrl+S：保存
  if (ctrl && e.key === "s" && !e.shiftKey) {
    e.preventDefault();
    void saveCurrentFile();
    return;
  }
  // Ctrl+Shift+E：切换到文件树（无工作区时切换到大纲）
  if (ctrl && e.shiftKey && (e.key === "E" || e.key === "e")) {
    e.preventDefault();
    sidebarView.value = workspace.hasWorkspace ? "files" : "outline";
    return;
  }
  // Ctrl+Shift+M：切换到大纲
  if (ctrl && e.shiftKey && (e.key === "M" || e.key === "m")) {
    e.preventDefault();
    sidebarView.value = "outline";
    return;
  }
  // Ctrl+Shift+F：在文件中查找（打开搜索面板）
  if (ctrl && e.shiftKey && (e.key === "F" || e.key === "f")) {
    e.preventDefault();
    searchStore.visible = true;
    return;
  }
  // Ctrl+R：重新加载当前文件
  if (ctrl && !e.shiftKey && (e.key === "r" || e.key === "R")) {
    e.preventDefault();
    void reloadCurrentFile();
    return;
  }
  // F11：切换全屏
  if (e.key === "F11") {
    e.preventDefault();
    void toggleFullscreen();
    return;
  }
  // Alt+Shift+S：切换状态栏显隐
  if (e.altKey && e.shiftKey && (e.key === "s" || e.key === "S")) {
    e.preventDefault();
    statusBarVisible.value = !statusBarVisible.value;
    return;
  }
}

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

// ===== 重新加载当前文件 =====
async function reloadCurrentFile(): Promise<void> {
  const path = activeTab.value?.path;
  if (!path) return;
  try {
    await tabsStore.reloadFromDisk(path);
  } catch (err) {
    console.error("重新加载失败:", err);
    dialog.alert({ message: `重新加载失败: ${err}`, variant: "error" });
  }
}

// ===== 文件操作 =====
async function openFile(path: string): Promise<void> {
  try {
    await tabsStore.openFile(path);
    workspace.selectFile(path);
    await persistence.addRecent(path, "file");
  } catch (err) {
    console.error("打开文件失败:", err);
    // 检测文件是否存在，若不存在则提供"从最近打开移除"选项
    const exists = await invoke<boolean>("path_exists", { path }).catch(() => false);
    if (!exists) {
      const fileName = basename(path);
      const shouldRemove = await dialog.confirm({
        message: `文件 "${fileName}" 不存在或已被移动。\n\n是否从"最近打开"列表中移除？`,
        danger: true,
      });
      if (shouldRemove) {
        await persistence.removeRecent(path);
      }
    } else {
      dialog.alert({ message: `打开文件失败: ${err}`, variant: "error" });
    }
  }
}

async function openFileViaDialog(): Promise<void> {
  const selected = await openDialog({
    multiple: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] }],
    title: "打开 Markdown 文件",
  });
  if (typeof selected === "string" && selected) {
    await openFile(selected);
  }
}

async function saveCurrentFile(): Promise<void> {
  if (!activeTab.value) return;
  if (!activeTab.value.path) {
    await saveAsCurrentFile();
    return;
  }
  try {
    await tabsStore.saveTab(activeTab.value.id);
  } catch (err) {
    console.error("保存失败:", err);
    dialog.alert({ message: `保存失败: ${err}`, variant: "error" });
  }
}

async function saveAsCurrentFile(): Promise<void> {
  if (!activeTab.value) return;
  const selected = await openDialog({
    directory: false,
    save: true,
    filters: [{ name: "Markdown", extensions: ["md"] }],
    title: "另存为",
    defaultPath: workspace.workspacePath ?? undefined,
  });
  if (typeof selected === "string" && selected) {
    try {
      await tabsStore.saveTabAs(activeTab.value.id, selected);
      await persistence.addRecent(selected, "file");
    } catch (err) {
      console.error("另存为失败:", err);
      dialog.alert({ message: `另存为失败: ${err}`, variant: "error" });
    }
  }
}

// ===== 大纲跳转 =====
function onJumpToLine(line: number): void {
  editorRef.value?.scrollToLine(line);
  editorRef.value?.focus();
}

// ===== 搜索结果点击：打开文件并跳转到匹配行 =====
async function onSearchSelectFile(filePath: string, line: number): Promise<void> {
  await openFile(filePath);
  // 等待编辑器加载
  requestAnimationFrame(() => {
    editorRef.value?.scrollToLine(line);
    editorRef.value?.focus();
  });
}

// ===== 文件树拖入图片：插入相对路径引用（不复制） =====
function onDropImagePath(absolutePath: string): void {
  imagePaste.insertExistingImage(absolutePath);
}

// ===== TabBar 批量关闭（右键菜单触发）=====
// 批量关闭使用 doCloseTab：未保存修改自动写入草稿，避免连续弹多个确认框
async function onCloseOthers(tabId: string): Promise<void> {
  const idx = tabsStore.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;
  const toClose = tabsStore.tabs.filter((_, i) => i !== idx).map((t) => t.id);
  for (const id of toClose) {
    await tabsStore.doCloseTab(id);
  }
}

async function onCloseRight(tabId: string): Promise<void> {
  const idx = tabsStore.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;
  const toClose = tabsStore.tabs.filter((_, i) => i > idx).map((t) => t.id);
  for (const id of toClose) {
    await tabsStore.doCloseTab(id);
  }
}

async function onCloseLeft(tabId: string): Promise<void> {
  const idx = tabsStore.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;
  const toClose = tabsStore.tabs.filter((_, i) => i < idx).map((t) => t.id);
  for (const id of toClose) {
    await tabsStore.doCloseTab(id);
  }
}

async function onCloseAllTabs(): Promise<void> {
  const toClose = tabsStore.tabs.map((t) => t.id);
  for (const id of toClose) {
    await tabsStore.doCloseTab(id);
  }
}

// ===== 编辑器右键菜单高级操作（由 SourceEditor 触发）=====
async function onEditorContextAction(
  action: "insert-table" | "insert-link" | "insert-image"
): Promise<void> {
  if (action === "insert-table") {
    tableDialogVisible.value = true;
    return;
  }
  if (action === "insert-link") {
    const url = await dialog.prompt({
      title: "插入链接",
      message: "请输入链接地址：",
      placeholder: "https://example.com",
    });
    if (!url) return;
    const text = await dialog.prompt({
      title: "插入链接",
      message: "请输入链接文字：",
      placeholder: "链接文字",
    });
    insertMarkdownAtCursor(`[${text ?? ""}](${url})`);
    return;
  }
  if (action === "insert-image") {
    const url = await dialog.prompt({
      title: "插入图片",
      message: "请输入图片地址：",
      placeholder: "https://example.com/image.png",
    });
    if (!url) return;
    const alt = await dialog.prompt({
      title: "插入图片",
      message: "请输入替代文字（可选）：",
      placeholder: "替代文字",
    });
    insertMarkdownAtCursor(`![${alt ?? ""}](${url})`);
    return;
  }
}

function insertMarkdownAtCursor(text: string): void {
  const view = editorRef.value?.getView();
  if (!view) return;
  view.focus();
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from + text.length },
    userEvent: "input.insert",
  });
}
// ===== TabBar 事件 =====
function onNewTab(): void {
  tabsStore.newTab("");
}

/**
 * 关闭 tab 请求：
 * - 若 agent 正在运行且关闭的是活动 tab：弹出合并对话框（Ticket #24c）
 *   - 有未保存修改：Cancel / Close without saving / Save and close
 *   - 无未保存修改：Cancel / Close anyway
 *   - 选择关闭时先 abort agent（保留部分回答到对话历史）
 * - 否则走原有的未保存修改检查
 */
async function onCloseTabRequest(tabId: string): Promise<void> {
  const tab = tabsStore.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  const isActiveTab = tabsStore.activeTabId === tabId;
  const agentRunning = agentStore.isThinking && isActiveTab;
  const hasUnsavedChanges = tab.isDirty;
  const fileName = tab.path ? basename(tab.path) : "未命名";

  // Case 1: Agent 运行中 + 关闭活动 tab + 有未保存修改 → 合并对话框（3 选项）
  if (agentRunning && hasUnsavedChanges) {
    const choice = await askCloseRunningTabMerged(fileName);
    if (choice === "cancel") return;

    // 中断 agent（cancel() 会保留部分回答到对话历史）
    agentStore.cancel();

    if (choice === "save") {
      // 保存后关闭
      if (tab.path) {
        try {
          await tabsStore.saveTab(tabId);
        } catch (err) {
          dialog.alert({ message: `保存失败: ${err}`, variant: "error" });
          return;
        }
      } else {
        const selected = await saveDialog({
          filters: [{ name: "Markdown", extensions: ["md"] }],
          title: "另存为",
          defaultPath: workspace.workspacePath ?? undefined,
        });
        if (typeof selected !== "string" || !selected) return;
        try {
          await tabsStore.saveTabAs(tabId, selected);
        } catch (err) {
          dialog.alert({ message: `另存为失败: ${err}`, variant: "error" });
          return;
        }
      }
    }
    // 不保存：跳过 dirty 检查直接关闭（草稿会自动写入）
    await tabsStore.doCloseTab(tabId);
    return;
  }

  // Case 2: Agent 运行中 + 关闭活动 tab + 无未保存修改 → 简单对话框（2 选项）
  if (agentRunning) {
    const choice = await askCloseRunningTabSimple(fileName);
    if (choice === "cancel") return;

    // 中断 agent
    agentStore.cancel();
    await tabsStore.doCloseTab(tabId);
    return;
  }

  // Case 3: 无 agent 运行 → 原有 dirty 检查
  if (!hasUnsavedChanges) {
    await tabsStore.closeTab(tabId);
    return;
  }

  // 有未保存修改：弹出三选一对话框
  const choice = await askCloseTabConfirm(fileName);
  if (choice === "cancel") return;

  if (choice === "save") {
    // 保存到磁盘
    if (tab.path) {
      try {
        await tabsStore.saveTab(tabId);
      } catch (err) {
        dialog.alert({ message: `保存失败: ${err}`, variant: "error" });
        return;
      }
    } else {
      // 无路径：走另存为
      const selected = await saveDialog({
        filters: [{ name: "Markdown", extensions: ["md"] }],
        title: "另存为",
        defaultPath: workspace.workspacePath ?? undefined,
      });
      if (typeof selected !== "string" || !selected) return;
      try {
        await tabsStore.saveTabAs(tabId, selected);
      } catch (err) {
        dialog.alert({ message: `另存为失败: ${err}`, variant: "error" });
        return;
      }
    }
  }
  // 不保存：跳过 dirty 检查直接关闭（草稿会自动写入）
  await tabsStore.doCloseTab(tabId);
}

/**
 * 关闭未保存 tab 的三选一对话框
 */
const closeConfirmState = ref<{
  visible: boolean;
  fileName: string;
  resolver: ((res: "save" | "dont-save" | "cancel") => void) | null;
}>({ visible: false, fileName: "", resolver: null });

function askCloseTabConfirm(
  fileName: string
): Promise<"save" | "dont-save" | "cancel"> {
  return new Promise((resolve) => {
    closeConfirmState.value = {
      visible: true,
      fileName,
      resolver: resolve,
    };
  });
}

function onCloseConfirmChoice(
  choice: "save" | "dont-save" | "cancel"
): void {
  const resolver = closeConfirmState.value.resolver;
  closeConfirmState.value = {
    visible: false,
    fileName: "",
    resolver: null,
  };
  if (resolver) resolver(choice);
}

// ===== Agent 运行中关闭 tab 的合并对话框 (Ticket #24c) =====
const closeRunningState = ref<{
  visible: boolean;
  fileName: string;
  mode: "merged" | "simple"; // merged: 有未保存修改；simple: 无未保存修改
  resolver: ((res: "save" | "close" | "cancel") => void) | null;
}>({ visible: false, fileName: "", mode: "simple", resolver: null });

/** 有未保存修改 + agent 运行：3 选项 (cancel / close without saving / save and close) */
function askCloseRunningTabMerged(
  fileName: string
): Promise<"save" | "close" | "cancel"> {
  return new Promise((resolve) => {
    closeRunningState.value = {
      visible: true,
      fileName,
      mode: "merged",
      resolver: resolve,
    };
  });
}

/** 无未保存修改 + agent 运行：2 选项 (cancel / close anyway) */
function askCloseRunningTabSimple(
  fileName: string
): Promise<"close" | "cancel"> {
  return new Promise((resolve) => {
    closeRunningState.value = {
      visible: true,
      fileName,
      mode: "simple",
      resolver: resolve as (res: "save" | "close" | "cancel") => void,
    };
  });
}

function onCloseRunningChoice(
  choice: "save" | "close" | "cancel"
): void {
  const resolver = closeRunningState.value.resolver;
  closeRunningState.value = {
    visible: false,
    fileName: "",
    mode: "simple",
    resolver: null,
  };
  if (resolver) resolver(choice);
}

// ===== WelcomePage 事件 =====
function onOpenFolder(): void {
  void workspace.openFolderDialog();
}

function onOpenFile(): void {
  void openFileViaDialog();
}

function onNewFile(): void {
  onNewTab();
}

async function onOpenRecent(path: string, type: "file" | "folder"): Promise<void> {
  if (type === "folder") {
    try {
      await workspace.openWorkspace(path);
    } catch (err) {
      console.error("打开工作区失败:", err);
      const exists = await invoke<boolean>("path_exists", { path }).catch(() => false);
      if (!exists) {
        const folderName = basename(path);
        const shouldRemove = await dialog.confirm({
          message: `文件夹 "${folderName}" 不存在或已被移动。\n\n是否从"最近打开"列表中移除？`,
          danger: true,
        });
        if (shouldRemove) {
          await persistence.removeRecent(path);
        }
      } else {
        dialog.alert({ message: `打开工作区失败: ${err}`, variant: "error" });
      }
    }
  } else {
    await openFile(path);
  }
}

// ===== 菜单事件 =====
async function handleMenuEvent(menuId: string): Promise<void> {
  switch (menuId) {
    case "new-file":
      onNewTab();
      break;
    case "open-file":
      await openFileViaDialog();
      break;
    case "open-folder":
      await workspace.openFolderDialog();
      break;
    case "close-workspace":
      workspace.closeWorkspace();
      break;
    case "save":
      await saveCurrentFile();
      break;
    case "save-as":
      await saveAsCurrentFile();
      break;
    case "close-tab":
      if (tabsStore.activeTabId) {
        await onCloseTabRequest(tabsStore.activeTabId);
      }
      break;
    case "reload-file":
      await reloadCurrentFile();
      break;
    case "export-html":
      await exportCurrentHtml();
      break;
    case "find-in-files":
      searchStore.visible = true;
      break;
    case "settings":
      await openSettings();
      break;
    case "theme-github":
      currentTheme.value = "github";
      break;
    case "theme-newsprint":
      currentTheme.value = "newsprint";
      break;
    case "theme-night":
      currentTheme.value = "night";
      break;
    case "theme-academic":
      currentTheme.value = "academic";
      break;
    // 段落菜单：调用编辑器命令
    case "heading-1":
    case "heading-2":
    case "heading-3":
    case "heading-4":
    case "heading-5":
    case "heading-6":
    case "normal": {
      const view = editorRef.value?.getView();
      if (view) {
        const level = menuId === "normal" ? 0 : parseInt(menuId.split("-")[1], 10);
        setHeading(view, level);
      }
      break;
    }
    case "code-block": {
      const view = editorRef.value?.getView();
      if (view) toggleCodeBlock(view);
      break;
    }
    case "blockquote": {
      const view = editorRef.value?.getView();
      if (view) toggleBlockquote(view);
      break;
    }
    case "unordered-list": {
      const view = editorRef.value?.getView();
      if (view) toggleList(view, "unordered");
      break;
    }
    case "ordered-list": {
      const view = editorRef.value?.getView();
      if (view) toggleList(view, "ordered");
      break;
    }
    case "task-list": {
      const view = editorRef.value?.getView();
      if (view) toggleList(view, "task");
      break;
    }
    case "horizontal-rule": {
      const view = editorRef.value?.getView();
      if (view) insertHorizontalRule(view);
      break;
    }
    case "insert-table": {
      // 打开插入表格对话框
      tableDialogVisible.value = true;
      break;
    }
    case "new-folder": {
      // 在工作区根目录新建文件夹
      if (!workspace.hasWorkspace) {
        dialog.alert({ message: "请先打开一个工作区", variant: "warning" });
        break;
      }
      const name = await dialog.prompt({ message: "请输入文件夹名称：", placeholder: "文件夹名称" });
      if (name && name.trim()) {
        try {
          await fileOps.createDirectory(workspace.workspacePath!, name.trim());
        } catch (err) {
          dialog.alert({ message: `新建文件夹失败: ${err}`, variant: "error" });
        }
      }
      break;
    }
    case "find":
    case "replace": {
      // 调用 CodeMirror 的搜索面板
      const view = editorRef.value?.getView();
      if (view) {
        const { openSearchPanel } = await import("@codemirror/search");
        openSearchPanel(view);
      }
      break;
    }
    case "quit": {
      try {
        await getCurrentWebviewWindow().close();
      } catch (err) {
        console.error("退出失败:", err);
      }
      break;
    }
    case "docs": {
      try {
        const { open } = await import("@tauri-apps/plugin-shell");
        await open("https://github.com/CatInRl/Murasaki");
      } catch {
        dialog.alert({ message: "文档暂未在线发布" });
      }
      break;
    }
    case "about": {
      dialog.alert({ title: "关于 Murasaki", message: "Murasaki v0.3.0\n轻量级本地 Markdown 文件管理编辑器\n基于 Tauri 2.x + Vue 3 + CodeMirror 6" });
      break;
    }
    case "check-updates": {
      dialog.alert({ message: "检查更新功能暂不支持（占位菜单项）" });
      break;
    }
    default:
      break;
  }
}

// ===== 表格插入确认 =====
function onTableInsertConfirm(rows: number, cols: number): void {
  tableDialogVisible.value = false;
  const view = editorRef.value?.getView();
  if (view) {
    insertTable(view, rows, cols);
    editorRef.value?.focus();
  }
}

// ===== HTML 导出 =====
async function exportCurrentHtml(): Promise<void> {
  if (!activeTab.value) {
    dialog.alert({ message: "请先打开一个文件", variant: "warning" });
    return;
  }
  const tab = activeTab.value;
  const defaultName = tab.path
    ? basename(tab.path).replace(/\.md$/i, "") + ".html"
    : "untitled.html";
  const selected = await saveDialog({
    defaultPath: defaultName,
    filters: [{ name: "HTML", extensions: ["html"] }],
    title: "导出 HTML",
  });
  if (typeof selected !== "string" || !selected) return;
  try {
    const html = await exportHtml({
      source: tab.content,
      theme: currentTheme.value,
      workspacePath: workspace.workspacePath ?? null,
      filePath: tab.path,
    });
    await invoke("write_text_file", { path: selected, content: html });
  } catch (err) {
    console.error("导出 HTML 失败:", err);
    dialog.alert({ message: `导出 HTML 失败: ${err}`, variant: "error" });
  }
}
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

    <!-- 冲突对话框 -->
    <ConflictDialog
      :visible="conflictState.visible"
      :target-path="conflictState.targetPath"
      :operation="conflictState.operation"
      :source-path="conflictState.sourcePath"
      @resolve="resolveConflict"
    />

    <!-- 对话框容器（Ticket #66） -->
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

    <!-- 外部修改三选一对话框 -->
    <NModal
      :show="externalChangeState.visible"
      :mask-closable="false"
      :close-on-esc="false"
      preset="card"
      title="文件已被外部修改"
      style="width: 480px; max-width: 92vw"
    >
      <NText depth="2">
        "{{ externalChangeState.filePath }}" 已被外部程序修改，但当前标签页有未保存的修改。请选择如何处理：
      </NText>
      <template #footer>
        <NSpace justify="end" :size="8">
          <NButton @click="onExternalChangeChoice('keep-local')">
            保留本地版本
          </NButton>
          <NButton @click="onExternalChangeChoice('compare')">
            对比并合并
          </NButton>
          <NButton
            type="primary"
            @click="onExternalChangeChoice('load-disk')"
          >
            加载磁盘版本
          </NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- 关闭未保存 tab 三选一对话框 -->
    <NModal
      :show="closeConfirmState.visible"
      :mask-closable="false"
      :close-on-esc="false"
      preset="card"
      title="未保存的修改"
      style="width: 440px; max-width: 92vw"
    >
      <NText depth="2">
        "{{ closeConfirmState.fileName }}" 有未保存的修改。是否在关闭前保存？
      </NText>
      <template #footer>
        <NSpace justify="end" :size="8">
          <NButton @click="onCloseConfirmChoice('cancel')">取消</NButton>
          <NButton @click="onCloseConfirmChoice('dont-save')">不保存</NButton>
          <NButton
            type="primary"
            @click="onCloseConfirmChoice('save')"
          >
            保存
          </NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- Agent 运行中关闭 tab 合并对话框 (Ticket #24c) -->
    <NModal
      :show="closeRunningState.visible"
      :mask-closable="false"
      :close-on-esc="false"
      preset="card"
      :title="closeRunningState.mode === 'merged' ? 'Agent 运行中 · 未保存的修改' : 'Agent 运行中'"
      style="width: 480px; max-width: 92vw"
    >
      <div style="display: flex; flex-direction: column; gap: 8px">
        <NText depth="2">
          Agent 正在为 "{{ closeRunningState.fileName }}" 处理请求。
        </NText>
        <template v-if="closeRunningState.mode === 'merged'">
          <NText depth="3" style="font-size: 12px">
            该文件有未保存的修改。关闭 tab 将中断 Agent 并保留已生成的部分回答到对话历史。
          </NText>
        </template>
        <template v-else>
          <NText depth="3" style="font-size: 12px">
            关闭 tab 将中断 Agent 并保留已生成的部分回答到对话历史。
          </NText>
        </template>
      </div>
      <template #footer>
        <NSpace justify="end" :size="8">
          <NButton @click="onCloseRunningChoice('cancel')">取消</NButton>
          <template v-if="closeRunningState.mode === 'merged'">
            <NButton @click="onCloseRunningChoice('close')">
              不保存关闭
            </NButton>
            <NButton
              type="primary"
              @click="onCloseRunningChoice('save')"
            >
              保存并关闭
            </NButton>
          </template>
          <NButton
            v-else
            type="warning"
            @click="onCloseRunningChoice('close')"
          >
            强制关闭
          </NButton>
        </NSpace>
      </template>
    </NModal>
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
