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
import GlobalSearchBar from "./components/GlobalSearchBar.vue";
import StatusBar from "./components/StatusBar.vue";
import TableInsertDialog from "./components/TableInsertDialog.vue";
import CompareWindow from "./components/CompareWindow.vue";
import ImagePreviewModal from "./components/ImagePreviewModal.vue";
import UpdateDialog from "./components/UpdateDialog.vue";
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
import { useToastStore } from "./stores/useToastStore";
import { useFileWatcher } from "./composables/useFileWatcher";
import { useImagePaste } from "./composables/useImagePaste";
import { isImageExt } from "./composables/useImagePaste";
import { useRecentMenuSync } from "./composables/useRecentMenuSync";
import { useFileActions } from "./composables/useFileActions";
import { useCopyRichText } from "./composables/useCopyRichText";
import { exportHtml } from "./composables/useHtmlExport";
import { useEditorNavigation } from "./composables/useEditorNavigation";
import { useCompareWindow } from "./composables/useCompareWindow";
import { useTabClose } from "./composables/useTabClose";
import { useCommands } from "./composables/useCommands";
import { useShortcuts } from "./shortcuts/useShortcuts";
import { toMenuAccelerators } from "./shortcuts/shortcutsLogic";
import { useAppLifecycle } from "./composables/useAppLifecycle";
import { useUpdater, type UpdateInfo } from "./composables/useUpdater";
import { setLocale } from "./i18n";
import { mapSystemLocale } from "./utils/systemLocale";
import { useI18n } from "vue-i18n";
import {
  fieldsForCategory,
  isDirty,
  isCategoryDirty,
  restoreCategoryDefaults,
} from "./settings/settingsLogic";
import { basename } from "./utils/path";
import { isMarkdownFile, isSourceOnlyFile } from "./utils/fileKind";
import { DEFAULT_THEME } from "./composables/useTheme";
import { useNaiveTheme } from "./composables/useNaiveTheme";
import { AGENT_ENABLED } from "./features";
import { undo as cmUndo, redo as cmRedo } from "@codemirror/commands";
import type { SidebarView, SettingsState } from "./types";
import type { SearchEntry } from "./search/searchLogic";
import { READING_FONT_PRESETS } from "./types";

const workspace = useWorkspaceStore();
const tabsStore = useTabsStore();
const persistence = usePersistenceStore();
const searchStore = useSearchStore();
const fileOps = useFileOpsStore();
const agentStore = useAgentStore();
const editorBridge = useEditorBridgeStore();
const proposalsStore = useProposalsStore();
const dialog = useDialogStore();
const toastStore = useToastStore();
const { t } = useI18n();

// ===== 主题 =====
const currentTheme = ref(DEFAULT_THEME);

// ===== naive-ui 主题对齐 --murasaki-* token（ADR-0005）=====
const { theme: naiveTheme, themeOverrides: naiveThemeOverrides } = useNaiveTheme();

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

// ===== 当前文件类型（issue 0.x：非 md 文件强制源码模式）=====
// 无路径（未命名新文件）默认按 markdown 处理
const currentIsMarkdown = computed(() =>
  currentFilePath.value ? isMarkdownFile(currentFilePath.value) : true
);
/** 非 markdown 的非文档文件（yaml/xml/txt 等）→ 强制源码-only */
const currentIsSourceOnly = computed(() =>
  currentFilePath.value ? isSourceOnlyFile(currentFilePath.value) : false
);
/** 传给编辑器的有效模式：源码-only 强制 source；html 禁用所见即所得（降到 split）；其余遵循用户设置 */
const effectiveEditorMode = computed<"source" | "split" | "wysiwyg">(() => {
  if (currentIsSourceOnly.value) return "source";
  // html 不走 WYSIWYG markdown 渲染 → 若有 wysiwyg 请求则退化为分屏（源码+预览）
  if (editorBridge.editorMode === "wysiwyg" && !currentIsMarkdown.value) return "split";
  return editorBridge.editorMode;
});

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
  reloadCurrentFile, exportCurrentHtml, exportCurrentPdf, onNewTab, onNewFile,
  onOpenFolder, onOpenFile, onOpenRecent,
} = useFileActions({ tabsStore, workspace, fileOps, persistence, dialog, toast: toastStore, activeTab, currentTheme });

// ===== 复制为富文本 composable（issue #108，复用 exportHtml 管线，走剪贴板而非文件）=====
const { copyRichText } = useCopyRichText({
  activeTab,
  currentTheme,
  workspace,
  toast: toastStore,
});

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

// ===== 侧栏宽度（可拖拽调整 + 折叠成细条，均持久化） =====
const SIDEBAR_MIN_WIDTH = 140;
const SIDEBAR_MAX_WIDTH = 600;
const SIDEBAR_COLLAPSED_WIDTH = 36;
const sidebarWidth = ref(260);
const sidebarCollapsed = ref(false);
/** 拖拽调宽进行中：关闭宽度过渡动画 + 禁用文本选择 */
const sidebarDragging = ref(false);

/** 侧栏实际宽度：折叠时固定细条宽度，否则用用户调整后的宽度 */
const sidebarStyle = computed(() => ({
  width: sidebarCollapsed.value ? `${SIDEBAR_COLLAPSED_WIDTH}px` : `${sidebarWidth.value}px`,
}));

/** 大纲视图可用性（与 Sidebar 一致：仅 markdown 文件） */
const canShowOutline = computed(() =>
  currentFilePath.value ? isMarkdownFile(currentFilePath.value) : true
);

/** 折叠状态下点击图标 → 展开侧栏并切换视图 */
function expandSidebar(view: SidebarView): void {
  sidebarCollapsed.value = false;
  sidebarView.value = view;
}

/** 侧栏右缘拖拽调宽（pointer events，Drag 期间禁止过渡与文本选择） */
function startResize(e: PointerEvent): void {
  if (sidebarCollapsed.value) return;
  e.preventDefault();
  // 指针捕获：指针移入主区域（如 HTML 预览 iframe）时 pointermove/up 会被 iframe 吞掉，
  // 导致缩小侧栏后无法拖回右侧。捕获后事件始终派发到本元素，拖拽双向可靠。
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  const startX = e.clientX;
  const startWidth = sidebarWidth.value;
  sidebarDragging.value = true;
  document.body.style.userSelect = "none";
  const onMove = (ev: PointerEvent) => {
    const w = startWidth + ev.clientX - startX;
    sidebarWidth.value = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(w)));
  };
  const onUp = () => {
    sidebarDragging.value = false;
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

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
    dialog.alert({ message: t("common.error.openSettingsFailed", { error: err }), variant: "error" });
  }
}

// ===== 更新检查（T1.1 / ADR-0012）=====
const updateDialogVisible = ref(false);
const updateDialogInfo = ref<UpdateInfo | null>(null);

const {
  check: checkForUpdate,
  downloadAndInstall: downloadUpdateAndInstall,
  downloading: updateDownloading,
} = useUpdater({
  toast: toastStore,
  onUpdateAvailable: (info) => {
    updateDialogInfo.value = info;
    updateDialogVisible.value = true;
  },
});

async function onUpdateConfirm(update: UpdateInfo): Promise<void> {
  await downloadUpdateAndInstall(update);
}

function onUpdateCancel(): void {
  updateDialogVisible.value = false;
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
  // 应用阅读字体预设（--murasaki-font-reading）
  document.documentElement.style.setProperty(
    "--murasaki-font-reading",
    READING_FONT_PRESETS[persistence.settings.editorFontPreset] ?? READING_FONT_PRESETS.d
  );
  // 应用保存的编辑模式（运行时切换，无需重启）
  editorBridge.setEditorMode(persistence.settings.editorMode);
  // 同步原生 "视图 / 显示模式" 菜单勾选（watcher 不触发首值时补一次）
  void invoke("set_mode_checked", {
    modeId: "mode-" + persistence.settings.editorMode,
  });
  // 应用保存的界面语言（ADR-0013，前端 i18n + Rust 菜单）
  // 首次启动（language 从未写入）时先探测系统语言作为默认并持久化（issue #141）；
  // 已持久化语言的既有用户跳过探测，保持原设置。
  let effectiveLanguage = persistence.settings.language;
  if (persistence.languageEmpty) {
    try {
      const detected = await invoke<string>("detect_system_locale");
      effectiveLanguage = mapSystemLocale(detected);
      await persistence.updateSettings({ language: effectiveLanguage });
    } catch (err) {
      console.warn("探测系统语言失败，使用默认语言:", err);
    }
  }
  setLocale(effectiveLanguage);
  void invoke("reload_menu", { lang: effectiveLanguage }).catch((err: unknown) =>
    console.warn("初始化菜单语言失败:", err)
  );
  // 同步已保存的快捷键覆盖到原生菜单（菜单项快捷键提示跟随用户自定义）
  void invoke("update_shortcut_labels", {
    overrides: toMenuAccelerators(persistence.settings.shortcuts ?? {}),
  }).catch((err: unknown) =>
    console.warn("初始化菜单快捷键失败:", err)
  );
  // 恢复侧栏视图
  if (persistence.settings.sidebarView) {
    sidebarView.value = persistence.settings.sidebarView;
  }
  // 恢复侧栏宽度与折叠状态（布局状态持久化）
  if (persistence.settings.sidebarWidth) {
    sidebarWidth.value = Math.min(
      SIDEBAR_MAX_WIDTH,
      Math.max(SIDEBAR_MIN_WIDTH, persistence.settings.sidebarWidth)
    );
  }
  sidebarCollapsed.value = persistence.settings.sidebarCollapsed;
  // 恢复上次打开的工作区（仅当开启"启动时打开上次工作区"，issue #96）
  if (persistence.settings.reopenLastWorkspace && persistence.settings.lastWorkspacePath) {
    try {
      console.log("[Murasaki] 恢复工作区:", persistence.settings.lastWorkspacePath);
      await workspace.openWorkspace(persistence.settings.lastWorkspacePath);
      console.log("[Murasaki] 恢复工作区成功, workspacePath:", workspace.workspacePath);
    } catch (err) {
      console.warn("[Murasaki] 恢复工作区失败:", err);
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

  // 11. 启动时静默检查更新（可被设置关闭，ADR-0012）
  //     silent=true：不弹 toast / 不弹对话框，仅填充 availableUpdate 状态
  if (persistence.settings.checkUpdatesOnStartup) {
    void checkForUpdate(true);
  }

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
  onJumpToLine, onDropImagePath,
  onEditorContextAction, onTableInsertConfirm,
} = useEditorNavigation({ editorRef, imagePaste, tableDialogVisible, dialog });

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
// 快捷键系统：读取 settings.shortcuts 覆盖，提供全局 keydown 匹配
const { matchGlobalKeydown } = useShortcuts();
const { handleMenuEvent, onKeyDown } = useCommands({
  onNewTab, openFileViaDialog, saveCurrentFile, saveAsCurrentFile,
  reloadCurrentFile, exportCurrentHtml, exportCurrentPdf, copyRichText,
  onCloseTabRequest,
  workspace, tabsStore, searchStore, fileOps, dialog,
  editorRef, currentTheme, sidebarView, statusBarVisible,
  tableDialogVisible,
  openSettings, toggleFullscreen,
  updater: { check: checkForUpdate },
  matchGlobalKeydown,
  persistence: { updateSettings: (patch) => persistence.updateSettings(patch) },
});

// ===== 拖拽/命令行打开文件或文件夹（issue #92 / #113）=====
// 分类处理：图片 → 复制到 assets 并插入编辑器；文件夹 → 设为工作区；其他 → 打开为 tab
function onOpenPath(path: string, type: "file" | "folder"): Promise<void> {
  if (type === "folder") {
    return workspace.openWorkspace(path);
  }
  const ext = path.split(".").pop() ?? "";
  if (isImageExt(ext)) {
    imagePaste.insertExistingImage(path);
    return Promise.resolve();
  }
  // 打开文件（若尚无工作区，openFile 内部会自动以文件所在目录为工作区，issue #96/#113）
  return openFile(path);
}

// ===== 统一搜索条选择处理（T2.1：标签切换 / openFile + 行跳转）=====
async function onSearchEntrySelect(entry: SearchEntry): Promise<void> {
  searchStore.visible = false;
  // 已打开的标签 → 直接切换（不重新加载，保留编辑状态）
  if (entry.isOpen && entry.tabId) {
    tabsStore.switchTo(entry.tabId);
    return;
  }
  // 未保存标签（path=null）无法打开
  if (!entry.path) return;
  await openFile(entry.path);
  // 内容命中 → 打开后跳转到命中行
  const line = entry.lineNumber;
  if (line !== undefined) {
    requestAnimationFrame(() => {
      editorRef.value?.scrollToLine(line);
      editorRef.value?.focus();
    });
  }
}

/** 搜索条关闭（Esc / 遮罩 / 清空未选择）：还原编辑器焦点 */
function onSearchClose(): void {
  searchStore.visible = false;
  requestAnimationFrame(() => editorRef.value?.focus());
}

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
  onOpenPath,
});

// ===== 侧栏布局状态持久化（gated：初始化完成后才落盘） =====
watch(sidebarWidth, (v) => {
  if (initialized.value) void persistence.updateSettings({ sidebarWidth: v });
});
watch(sidebarCollapsed, (v) => {
  if (initialized.value) void persistence.updateSettings({ sidebarCollapsed: v });
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
        :class="{ collapsed: sidebarCollapsed, dragging: sidebarDragging }"
        :style="sidebarStyle"
      >
        <!-- 折叠态：细条图标栏（点击图标展开对应视图） -->
        <div v-if="sidebarCollapsed" class="sidebar-collapsed-rail">
          <button
            v-if="workspace.hasWorkspace"
            class="sidebar-rail-btn"
            type="button"
            :title="$t('editor.sidebar.filesTab') + ' (Ctrl+Shift+E)'"
            :aria-label="$t('editor.sidebar.filesTabAria')"
            @click="expandSidebar('files')"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
            </svg>
          </button>
          <button
            v-if="canShowOutline"
            class="sidebar-rail-btn"
            type="button"
            :title="$t('editor.sidebar.outlineTab') + ' (Ctrl+Shift+M)'"
            :aria-label="$t('editor.sidebar.outlineTabAria')"
            @click="expandSidebar('outline')"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="8" y1="6" x2="21" y2="6"/>
              <line x1="8" y1="12" x2="21" y2="12"/>
              <line x1="8" y1="18" x2="21" y2="18"/>
              <line x1="3" y1="6" x2="3.01" y2="6"/>
              <line x1="3" y1="12" x2="3.01" y2="12"/>
              <line x1="3" y1="18" x2="3.01" y2="18"/>
            </svg>
          </button>
          <div class="sidebar-rail-spacer"></div>
          <button
            class="sidebar-rail-btn"
            type="button"
            :title="$t('editor.sidebar.expandSidebar')"
            :aria-label="$t('editor.sidebar.expandSidebar')"
            @click="sidebarCollapsed = false"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
        </div>
        <!-- 展开态：完整侧栏 + 收起按钮 -->
        <template v-else>
          <Sidebar
            :current-file-path="currentFilePath"
            :current-content="activeContent"
            :active-view="sidebarView"
            :has-workspace="workspace.hasWorkspace"
            @select-file="openFile"
            @jump-to-line="onJumpToLine"
            @preview-image="onPreviewImage"
            @update:active-view="(v) => (sidebarView = v)"
          />
          <button
            class="murasaki-sidebar-collapse"
            type="button"
            :title="$t('editor.sidebar.collapseSidebar')"
            :aria-label="$t('editor.sidebar.collapseSidebar')"
            @click="sidebarCollapsed = true"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
          <!-- 右缘拖拽调宽把手 -->
          <div class="murasaki-sidebar-resizer" @pointerdown="startResize" />
        </template>
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
            :editor-mode="effectiveEditorMode"
            :font-size="persistence.settings.editorFontSize"
            :line-height="persistence.settings.editorLineHeight"
            :font-family="persistence.settings.editorFontFamily"
            :fullwidth-to-markdown="persistence.settings.fullwidthToMarkdown"
            @cursor-change="onCursorChange"
            @open-internal="openFile"
            @drop-image-path="onDropImagePath"
            @context-action="onEditorContextAction"
          />

          <!-- 统一搜索条：Ctrl+P / Ctrl+Shift+F（取代旧 find-in-files 底部面板） -->
          <GlobalSearchBar
            v-if="searchStore.visible"
            @select="onSearchEntrySelect"
            @close="onSearchClose"
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

      <!-- Agent 面板（AGENT_ENABLED 关闭时隐藏整个入口，issue #112；非 markdown 文件隐藏，issue 0.x） -->
      <AgentPanel
        v-if="AGENT_ENABLED && persistence.settings.showAgentPanel && currentIsMarkdown"
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

    <!-- 更新提示对话框（T1.1 / ADR-0012）-->
    <UpdateDialog
      :visible="updateDialogVisible"
      :update="updateDialogInfo"
      :downloading="updateDownloading"
      @cancel="onUpdateCancel"
      @confirm="onUpdateConfirm"
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
  /* width 由 inline style 控制（sidebarStyle：用户可拖拽调整 / 折叠为细条） */
  position: relative;
  flex-shrink: 0;
  border-right: 1px solid var(--murasaki-line);
  background: var(--murasaki-surface);
  overflow: hidden;
  transition: width var(--murasaki-duration-base) var(--murasaki-ease);
}

/* 拖拽调宽期间：关闭过渡动画，避免拖拽滞后 */
.murasaki-sidebar.dragging {
  transition: none;
  cursor: col-resize;
}

/* === 侧栏右缘拖拽调宽把手 === */
.murasaki-sidebar-resizer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 5px;
  z-index: 20;
  cursor: col-resize;
}
.murasaki-sidebar-resizer:hover,
.murasaki-sidebar.dragging .murasaki-sidebar-resizer {
  background: var(--murasaki-primary);
  opacity: 0.25;
}

/* === 收起侧栏按钮（展开态，侧栏头部右上角） === */
.murasaki-sidebar-collapse {
  position: absolute;
  top: 6px;
  right: 8px;
  z-index: 21;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--murasaki-ink-3);
  border-radius: var(--murasaki-radius-sm);
  cursor: pointer;
  padding: 0;
  transition: background var(--murasaki-duration-fast) var(--murasaki-ease),
              color var(--murasaki-duration-fast) var(--murasaki-ease);
}
.murasaki-sidebar-collapse:hover {
  background: var(--murasaki-neutral-200);
  color: var(--murasaki-ink-2);
}

/* === 折叠态：细条图标栏 === */
.sidebar-collapsed-rail {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 0;
}
.sidebar-rail-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  background: transparent;
  color: var(--murasaki-ink-3);
  border-radius: var(--murasaki-radius-sm);
  cursor: pointer;
  padding: 0;
  transition: background var(--murasaki-duration-fast) var(--murasaki-ease),
              color var(--murasaki-duration-fast) var(--murasaki-ease);
}
.sidebar-rail-btn:hover {
  background: var(--murasaki-neutral-200);
  color: var(--murasaki-primary);
}
.sidebar-rail-spacer {
  flex: 1;
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
