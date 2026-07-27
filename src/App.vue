<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import {
  NConfigProvider,
  NLayout,
  NLayoutSider,
  NSelect,
  NModal,
  NButton,
  NSpace,
  NText,
  lightTheme,
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
import SettingsWindow from "./components/SettingsWindow.vue";
import CompareWindow from "./components/CompareWindow.vue";
import ImagePreviewModal from "./components/ImagePreviewModal.vue";
import { useWorkspaceStore } from "./stores/useWorkspaceStore";
import { useTabsStore } from "./stores/useTabsStore";
import { usePersistenceStore } from "./stores/usePersistenceStore";
import { useSearchStore } from "./stores/useSearchStore";
import { useFileOpsStore } from "./stores/useFileOpsStore";
import { useFileWatcher } from "./composables/useFileWatcher";
import { useImagePaste } from "./composables/useImagePaste";
import { MARKDOWN_THEMES, DEFAULT_THEME } from "./composables/useTheme";
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
import type { SidebarView } from "./types";

const workspace = useWorkspaceStore();
const tabsStore = useTabsStore();
const persistence = usePersistenceStore();
const searchStore = useSearchStore();
const fileOps = useFileOpsStore();

// ===== 主题 =====
const currentTheme = ref(DEFAULT_THEME);
const themeOptions = MARKDOWN_THEMES.map((t) => ({
  label: t.label,
  value: t.name,
}));

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

// ===== 设置窗口 =====
const settingsWindowVisible = ref(false);

// ===== 图片预览弹窗 =====
const imagePreviewVisible = ref(false);
const imagePreviewPath = ref<string | null>(null);

function onPreviewImage(path: string): void {
  imagePreviewPath.value = path;
  imagePreviewVisible.value = true;
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
let initialized = ref(false);

onMounted(async () => {
  // 1. 加载持久化状态
  await persistence.loadSettings();
  await persistence.loadRecent();

  // 应用保存的主题
  if (persistence.settings.markdownTheme) {
    currentTheme.value = persistence.settings.markdownTheme;
  }
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
  window.removeEventListener("keydown", onKeyDown);
  fileWatcher.stop();
  imagePaste.teardown();
  fileOps.setConflictResolver(null);
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

// 工作区变化时保存（关闭工作区或切换工作区）
watch(() => workspace.workspacePath, (p) => {
  if (initialized.value) {
    void persistence.updateSettings({ lastWorkspacePath: p });
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
      alert(`文件已被外部删除：${path}`);
    } else {
      alert(`文件已被外部删除（草稿已保留）：${path}`);
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
    alert(`保存合并结果失败: ${err}`);
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
    alert(`重新加载失败: ${err}`);
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
      const shouldRemove = confirm(
        `文件 "${fileName}" 不存在或已被移动。\n\n是否从"最近打开"列表中移除？`
      );
      if (shouldRemove) {
        await persistence.removeRecent(path);
      }
    } else {
      alert(`打开文件失败: ${err}`);
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
    alert(`保存失败: ${err}`);
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
      alert(`另存为失败: ${err}`);
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

// ===== 设置变更处理 =====
// 同步设置到应用状态：主题、行号、软折行立即生效；其他需重启
function onSettingsChange(
  field: keyof typeof persistence.settings,
  value: unknown
): void {
  switch (field) {
    case "markdownTheme":
      currentTheme.value = value as string;
      break;
    case "showHiddenFiles":
      // 切换后刷新文件树（若工作区已打开）
      if (workspace.hasWorkspace) {
        void workspace.refreshTree();
      }
      break;
    case "showLineNumbers":
    case "softWrap":
      // 这些通过 persistence.settings 响应式传递给 EditorPane（v-bind :show-line-numbers / :soft-wrap）
      break;
    case "uiMode":
    case "editorMode":
      // 需重启应用完全生效（仅在设置窗口提示，不在此处处理）
      break;
  }
}

// ===== TabBar 事件 =====
function onNewTab(): void {
  tabsStore.newTab("");
}

/**
 * 关闭 tab 请求：若有未保存修改，弹出"保存 / 不保存 / 取消"对话框
 */
async function onCloseTabRequest(tabId: string): Promise<void> {
  const tab = tabsStore.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  // 无未保存修改：直接关闭
  if (!tab.isDirty) {
    await tabsStore.closeTab(tabId);
    return;
  }

  // 有未保存修改：弹出三选一对话框
  const fileName = tab.path ? basename(tab.path) : "未命名";
  const choice = await askCloseTabConfirm(fileName);
  if (choice === "cancel") return;

  if (choice === "save") {
    // 保存到磁盘
    if (tab.path) {
      try {
        await tabsStore.saveTab(tabId);
      } catch (err) {
        alert(`保存失败: ${err}`);
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
        alert(`另存为失败: ${err}`);
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
        const shouldRemove = confirm(
          `文件夹 "${folderName}" 不存在或已被移动。\n\n是否从"最近打开"列表中移除？`
        );
        if (shouldRemove) {
          await persistence.removeRecent(path);
        }
      } else {
        alert(`打开工作区失败: ${err}`);
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
      settingsWindowVisible.value = true;
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
        alert("请先打开一个工作区");
        break;
      }
      const name = prompt("请输入文件夹名称：");
      if (name && name.trim()) {
        try {
          await fileOps.createDirectory(workspace.workspacePath!, name.trim());
        } catch (err) {
          alert(`新建文件夹失败: ${err}`);
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
        alert("文档暂未在线发布");
      }
      break;
    }
    case "about": {
      alert("Murasaki v0.1.0\n轻量级本地 Markdown 文件管理编辑器\n基于 Tauri 2.x + Vue 3 + CodeMirror 6");
      break;
    }
    case "check-updates": {
      alert("检查更新功能暂不支持（占位菜单项）");
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
    alert("请先打开一个文件");
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
    alert(`导出 HTML 失败: ${err}`);
  }
}
</script>

<template>
  <NConfigProvider :theme="lightTheme" :locale="null" :date-locale="null">
    <NLayout style="height: 100vh" has-sider>
      <!-- Sidebar: 文件树 / 大纲 -->
      <NLayoutSider
        v-if="workspace.hasWorkspace || tabsStore.hasTabs"
        bordered
        :width="260"
        :collapsed-width="0"
        :native-scrollbar="false"
        show-trigger="bar"
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
      </NLayoutSider>

      <!-- 主区域 -->
      <div class="main-area">
        <!-- 顶部：Tab 栏 + 主题选择 -->
        <div class="top-bar">
          <TabBar
            v-if="tabsStore.hasTabs"
            class="tab-bar-slot"
            @new-tab="onNewTab"
            @close-tab="onCloseTabRequest"
          />
          <div v-else class="top-bar-title">
            <span class="app-name">Murasaki</span>
          </div>
          <NSelect
            v-model:value="currentTheme"
            :options="themeOptions"
            size="small"
            style="width: 130px; flex-shrink: 0"
            placeholder="主题"
          />
        </div>

        <!-- 内容区：欢迎页 或 编辑器 + 底部搜索面板 -->
        <div class="content-area">
          <WelcomePage
            v-if="!tabsStore.hasTabs"
            @open-folder="onOpenFolder"
            @open-file="onOpenFile"
            @new-file="onNewFile"
            @open-recent="onOpenRecent"
            @open-settings="settingsWindowVisible = true"
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
            @cursor-change="onCursorChange"
            @open-internal="openFile"
            @drop-image-path="onDropImagePath"
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
        />
      </div>
    </NLayout>

    <!-- 冲突对话框 -->
    <ConflictDialog
      :visible="conflictState.visible"
      :target-path="conflictState.targetPath"
      :operation="conflictState.operation"
      :source-path="conflictState.sourcePath"
      @resolve="resolveConflict"
    />

    <!-- 插入表格对话框 -->
    <TableInsertDialog
      :visible="tableDialogVisible"
      @confirm="onTableInsertConfirm"
      @cancel="tableDialogVisible = false"
    />

    <!-- 设置窗口 -->
    <SettingsWindow
      :visible="settingsWindowVisible"
      @close="settingsWindowVisible = false"
      @change="onSettingsChange"
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
  </NConfigProvider>
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html,
body,
#app {
  height: 100%;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

.main-area {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}

.content-area {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.search-panel-slot {
  height: 240px;
  flex-shrink: 0;
  border-top: 1px solid #e0e0e6;
}

.top-bar {
  height: 36px;
  padding: 0 8px;
  border-bottom: 1px solid var(--n-border-color, #e0e0e6);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.tab-bar-slot {
  flex: 1;
  min-width: 0;
}

.top-bar-title {
  flex: 1;
  display: flex;
  align-items: center;
  padding: 0 4px;
}

.app-name {
  font-size: 13px;
  font-weight: 600;
  color: #666;
}
</style>
