<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch } from "vue";
import { storeToRefs } from "pinia";
import { NConfigProvider } from "naive-ui";
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
import ToastContainer from "./components/ToastContainer.vue";
import DialogContainer from "./components/DialogContainer.vue";
import ContextMenuContainer from "./components/ContextMenuContainer.vue";
import SettingsApp from "./settings/SettingsApp.vue";
import { useWorkspaceStore } from "./stores/useWorkspaceStore";
import { useTabsStore } from "./stores/useTabsStore";
import { usePersistenceStore } from "./stores/usePersistenceStore";
import { useSearchStore } from "./stores/useSearchStore";
import { useFileOpsStore } from "./stores/useFileOpsStore";
import { useEditorBridgeStore } from "./stores/useEditorBridgeStore";
import { useDialogStore } from "./stores/useDialogStore";
import { useToastStore } from "./stores/useToastStore";
import { useFileWatcher } from "./composables/useFileWatcher";
import { useImagePaste } from "./composables/useImagePaste";
import { useRecentMenuSync } from "./composables/useRecentMenuSync";
import { useFileActions } from "./composables/useFileActions";
import { useDragDrop } from "./composables/useDragDrop";
import { useCopyRichText } from "./composables/useCopyRichText";
import { exportHtml } from "./composables/useHtmlExport";
import { useEditorNavigation } from "./composables/useEditorNavigation";
import { useCompareWindow } from "./composables/useCompareWindow";
import { useTabClose } from "./composables/useTabClose";
import { useCommands } from "./composables/useCommands";
import { useShortcuts } from "./shortcuts/useShortcuts";
import { toMenuAccelerators } from "./shortcuts/shortcutsLogic";
import { useAppLifecycle } from "./composables/useAppLifecycle";
import { useSidebarLayout } from "./composables/useSidebarLayout";
import { bootstrapApp, type AppStartupHandle } from "./composables/useAppStartup";
import { useModeMenuSync } from "./composables/useModeMenuSync";
import { useExitFlush, type ExitFlushChoice, type ExitFlushTab } from "./composables/useExitFlush";
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
import { isMarkdownFile, isSourceOnlyFile, isImageFile } from "./utils/fileKind";
import { DEFAULT_THEME } from "./composables/useTheme";
import { useNaiveTheme } from "./composables/useNaiveTheme";
import { undo as cmUndo, redo as cmRedo } from "@codemirror/commands";
import type { SidebarView, EditorMode } from "./types";
import type { SearchEntry } from "./search/searchLogic";
import { resolveSearchJumpLine } from "./search/searchLogic";
import { applyReadingFontPreset } from "./utils/readingFont";
import { formatCommandError } from "./utils/commandError";
import {
  PRESENTATION_ZOOM_DEFAULT,
  stepPresentationZoom,
  zoomAppliesTo,
} from "./utils/presentationZoom";
import { countChars, countWords } from "./utils/textStats";

const workspace = useWorkspaceStore();
const tabsStore = useTabsStore();
const persistence = usePersistenceStore();
const searchStore = useSearchStore();
const fileOps = useFileOpsStore();
const editorBridge = useEditorBridgeStore();
const dialog = useDialogStore();
const toastStore = useToastStore();
const { t } = useI18n();

// ===== 草稿冲突裁决（#425）=====
// 草稿基线与磁盘 mtime 不一致时，让用户选择「保留草稿」还是「加载磁盘版本」，
// 而不是静默丢弃草稿。取消 = 用磁盘内容打开，草稿文件保留。
tabsStore.setDraftConflictResolver(
  async ({ path, diskContent, draftContent, diskMtime, draftSavedAt }) => {
    const preview = (text: string): string => {
      const line = text.split(/\r?\n/).find((item) => item.trim().length > 0) ?? "";
      return line.length > 40 ? `${line.slice(0, 40)}…` : line;
    };
    const formatTime = (ms: number): string => (ms > 0 ? new Date(ms).toLocaleString() : "");

    const choice = await dialog.unsavedChanges({
      title: t("common.dialog.draftConflictTitle"),
      message: t("common.dialog.draftConflictMessage", {
        name: basename(path),
        diskTime: formatTime(diskMtime),
        diskPreview: preview(diskContent),
        draftTime: formatTime(draftSavedAt),
        draftPreview: preview(draftContent),
      }),
      saveText: t("common.dialog.draftConflictKeep"),
      discardText: t("common.dialog.draftConflictLoadDisk"),
      cancelText: t("common.dialog.draftConflictLater"),
    });
    if (choice === "save") return "keep-draft";
    if (choice === "discard") return "load-disk";
    return "cancel";
  }
);

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

/**
 * 窗口标题（#442）：有工作区用工作区名，否则用当前标签名。
 * 多窗口下「无工作区」窗口此前都叫 Murasaki，任务栏与窗口切换器无法区分。
 */
const windowTitle = computed(() => {
  const base = workspace.hasWorkspace
    ? workspace.workspaceName
    : activeTab.value
      ? tabsStore.getTabTitle(activeTab.value, t("common.untitled"))
      : "";
  return base ? `${base} — Murasaki` : "Murasaki";
});

watch(
  windowTitle,
  (title) => {
    void invoke("set_window_title", { title }).catch((err: unknown) =>
      console.warn("同步窗口标题失败:", err)
    );
  },
  // 启动后立即推一次权威标题：Rust 只负责建窗时的初始标题，
  // 工作区恢复失败等场景不会再有人来纠正
  { immediate: true }
);

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
const effectiveEditorMode = computed<EditorMode>(() => {
  if (currentIsSourceOnly.value) return "source";
  // html 不走 WYSIWYG markdown 渲染 → 若有 wysiwyg 请求则退化为分屏（源码+预览）
  if (editorBridge.editorMode === "wysiwyg" && !currentIsMarkdown.value) return "split";
  return editorBridge.editorMode;
});
// 菜单勾选跟随「生效模式」而非全局偏好（issue #381）：source-only 文件上
// 生效模式恒为 source，偏好值推送会把勾选拽离实际编辑器行为
useModeMenuSync(effectiveEditorMode);

/** 预览缩放百分比（持久化于 settings.presentationZoom，分屏 + 演示生效，#412） */
const presentationZoom = computed(() => persistence.settings.presentationZoom);

/** 缩放生效于有预览区的模式（分屏 + 演示，#412）：入口与 EditorPane 的出口门控必须一致，
 * 否则分屏下「入口关、出口开」变成状态永不变，或「入口开、出口关」变成状态在变内容不动 */
function zoomEnabled(): boolean {
  return zoomAppliesTo(effectiveEditorMode.value);
}

async function onZoomStep(direction: 1 | -1): Promise<void> {
  if (!zoomEnabled()) return;
  await persistence.updateSettings({
    presentationZoom: stepPresentationZoom(presentationZoom.value, direction),
  });
}

async function zoomIn(): Promise<void> {
  await onZoomStep(1);
}

async function zoomOut(): Promise<void> {
  await onZoomStep(-1);
}

async function zoomReset(): Promise<void> {
  if (!zoomEnabled()) return;
  await persistence.updateSettings({ presentationZoom: PRESENTATION_ZOOM_DEFAULT });
}

/**
 * 切换显示模式（菜单 / 状态栏下拉 / 模式快捷键统一入口）。
 * 写入 settings.editorMode，经 useAppLifecycle watcher 同步 editorBridge 与原生菜单勾选。
 * source-only 文件（yaml/txt/json…）永远只读源码，其上的切换不写回设置 ——
 * 这样该字段始终保存「markdown 文件的最后一次模式」，切回 .md 时自然恢复。
 * 拒绝切换时给 toast 反馈，不静默吞掉操作（issue #382）。
 */
async function onSelectMode(mode: EditorMode): Promise<void> {
  if (currentIsSourceOnly.value) {
    toastStore.info(t("common.toast.sourceOnlyMode"));
    return;
  }
  if (persistence.settings.editorMode === mode) return;
  await persistence.updateSettings({ editorMode: mode });
}

// ===== 文件操作 composable（磁盘 IO 类入口）=====
const {
  openFile,
  openFileViaDialog,
  openPathInNewWindow,
  saveCurrentFile,
  saveAsCurrentFile,
  reloadCurrentFile,
  exportCurrentHtml,
  exportCurrentPdf,
  onNewTab,
  onNewFile,
  onOpenFolder,
  onOpenFile,
  onOpenRecent,
  notifyUnsupportedFiles,
  notifyIgnoredFolders,
  openWithDefaultApp,
} = useFileActions({
  tabsStore,
  workspace,
  fileOps,
  persistence,
  dialog,
  toast: toastStore,
  activeTab,
  currentTheme,
});

// ===== 拖放打开（原生 drag-drop，issue #92）=====
// 单个目录 → 走「打开文件夹」同一路径（同目录已开则聚焦，否则新窗口）；文件 → 当前窗口逐个开标签。
// 图片 → 当前窗口编辑器按插入方式插入（issue #288，见 onDropImages）。
// 打不开的文件 → 一次提示 +（单个时）兜底出口（issue #317，见 notifyUnsupportedFiles）；
// 被忽略的目录（多目录 / 目录与文件混投）→ 一次纯提示（issue #318，见 notifyIgnoredFolders）。
const {
  dragging: dropDragging,
  setup: setupDragDrop,
  teardown: teardownDragDrop,
} = useDragDrop({
  openFile,
  openFolder: openPathInNewWindow,
  insertImages: onDropImages,
  notifyUnsupportedFiles,
  notifyIgnoredFolders,
});

// ===== 复制为富文本 composable（issue #108，复用 exportHtml 管线，走剪贴板而非文件）=====
const { copyRichText } = useCopyRichText({
  activeTab,
  currentTheme,
  workspace,
  toast: toastStore,
});

// ===== 对比窗口 + 外部修改处理 composable（三选一对话框改走 dialog store）=====
const { compareState, handleExternalChange, onCompareSave, onCompareUseExternal, onCompareClose } =
  useCompareWindow({ tabsStore, dialog });

// ===== Tab 关闭逻辑 composable（对话框改走 dialog store）=====
const {
  onCloseTabRequest,
  onCloseOthers,
  onCloseRight,
  onCloseLeft,
  onCloseAllTabs,
  saveBeforeClose,
} = useTabClose({ tabsStore, dialog, workspace });

// ===== 侧栏视图（受控） =====
const sidebarView = ref<SidebarView>("files");

// ===== 「全部标签」面板展开状态（TabBar 受控，快捷键与按钮共用，issue #168）=====
const allTabsOpen = ref(false);

// ===== 侧栏宽度（可拖拽调整 + 折叠成细条，均持久化）=====
// 状态、拖拽与持久化集中在 useSidebarLayout（#433）；实例在 setup 阶段创建，
// initialized 由启动流程在恢复完成后置位（之前不写回设置）。

/** 大纲视图可用性（与 Sidebar 一致：仅 markdown 文件） */
const canShowOutline = computed(() =>
  currentFilePath.value ? isMarkdownFile(currentFilePath.value) : true
);

/** 折叠状态下点击图标 → 展开侧栏并切换视图 */
function expandSidebar(view: SidebarView): void {
  layout.expand();
  sidebarView.value = view;
}

/** 折叠细条上的「展开」按钮：只展开，不改视图 */
function expandRail(): void {
  layout.expand();
}

/** 展开态右上角的「收起」按钮 */
function collapseSidebar(): void {
  layout.collapse();
}

/**
 * 侧栏视图切换的统一入口（菜单 / 快捷键，issue #340）。
 *
 * - 折叠态下先展开：否则视图换了但只剩一排图标，用户看不到任何变化（表现为「点了没反应」）
 * - 大纲只对 Markdown 有意义：当前文件不是 md 时给出说明，而不是静默留在文件树
 */
function selectSidebarView(view: SidebarView): void {
  if (view === "outline" && !canShowOutline.value) {
    expandSidebar("files");
    dialog.alert({ message: t("editor.commands.outlineNeedsMarkdown"), variant: "warning" });
    return;
  }
  expandSidebar(view);
}

/** WelcomePage 的「新建文件」入口（#442）：与菜单一致，先让文件树内联命名框可见 */
function onNewFileFromWelcome(): void {
  if (workspace.hasWorkspace) selectSidebarView("files");
  onNewFile();
}

// ===== 状态栏 / 全屏 =====
const statusBarVisible = ref(true);

// ===== 光标位置与字数统计 =====
const cursorLine = ref(1);
const cursorCol = ref(0);
/** 字符数（不含空白字符的字符总数，口径见 CONTEXT.md） */
const charCount = computed(() => countChars(activeContent.value));
/** 字数（CJK 逐字 + 拉丁逐词） */
const wordCount = computed(() => countWords(activeContent.value));

function onCursorChange(payload: { line: number; ch: number }) {
  cursorLine.value = payload.line;
  cursorCol.value = payload.ch;
  // 同时记进 tab / 会话，供跨重启恢复（ADR-0022 Q13）。
  // 过去光标位置从不更新，tabs.json 里存的永远是初始的 {line:1,ch:0}。
  const id = tabsStore.activeTabId;
  if (id) tabsStore.updateCursor(id, payload);
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

// ===== 设置页（单入口路由，在主窗口内通过 navigate 事件切换） =====
const settingsVisible = ref(false);
const settingsRef = ref<InstanceType<typeof SettingsApp> | null>(null);

/**
 * 设置页关闭 / 退出前先让设置页处理未保存草稿（#442）。
 * 返回 false 表示用户选择「取消」（或确认过程本身出错）。
 *
 * 确认期间复用同一个 Promise：连按 Ctrl+Q / 关窗请求与退出请求叠加时，
 * 不会向对话框队列压入第二张「设置未保存」确认框。
 */
let settingsCloseRequest: Promise<boolean> | null = null;

async function confirmSettingsClosed(): Promise<boolean> {
  if (!settingsVisible.value) return true;
  if (settingsCloseRequest) return settingsCloseRequest;
  settingsCloseRequest = (async () => {
    try {
      // 刚由 navigate 事件切到设置页时组件可能尚未挂载，等一拍再取 ref
      await nextTick();
      return (await settingsRef.value?.requestClose()) ?? true;
    } catch (err) {
      // 保存 / 弹窗异常按「取消」处理：宁可关不掉，也不要静默丢稿
      console.error("[Murasaki] 设置页关闭确认失败，按取消处理:", err);
      return false;
    } finally {
      settingsCloseRequest = null;
    }
  })();
  return settingsCloseRequest;
}

/**
 * 退出应用（菜单 / Ctrl+Q）。设置页打开时先走它的未保存确认，
 * 否则 Ctrl+Q 会静默丢掉设置草稿（#442）。
 */
async function quitApp(): Promise<void> {
  if (!(await confirmSettingsClosed())) return;
  try {
    await invoke("quit_app");
  } catch (err) {
    console.error("退出失败:", err);
  }
}

async function openSettings(): Promise<void> {
  try {
    await invoke("open_settings");
  } catch (err) {
    console.error("打开设置窗口失败:", err);
    dialog.alert({
      message: t("common.error.openSettingsFailed", { error: formatCommandError(err) }),
      variant: "error",
    });
  }
}

// 设置页出现时把焦点从编辑器移走：只靠按键拦截挡不住 CodeMirror 的
// 编辑器级快捷键（Ctrl+F / Ctrl+B）与直接输入（#442）
watch(settingsVisible, (visible) => {
  if (visible) editorRef.value?.getView()?.contentDOM.blur();
});

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
// 启动顺序与各步清理见 useAppStartup（#433）

/**
 * 退出前的未保存改动确认（issue #346 / ADR-0017 修订）。
 *
 * 把本窗口所有 dirty tab **一次性汇总**成一个三选一对话框（与批量关闭 tab 同款），
 * 返回 `cancel` = 取消退出：窗口不关、也不落盘。
 *
 * - 选「保存」：逐个写回（已命名走写盘、未命名走另存为），任一取消或失败即**中止退出**
 * - 选「不保存」：不回写文件，也不留草稿（issue #426）
 */
async function resolveUnsavedOnExit(dirty: readonly ExitFlushTab[]): Promise<ExitFlushChoice> {
  const names = dirty
    .map((tab) => (tab.path ? basename(tab.path) : t("common.untitled")))
    .join("、");
  // 已命名 tab 选择「不保存」= 真丢弃（不写文件、不留草稿）；
  // 未命名 tab 没有磁盘可回退，正文只能随 tabs.json 保存，因此这里显式清空。
  const choice = await dialog.unsavedChanges({
    title: t("common.dialog.unsavedBeforeExitTitle"),
    message: t("common.dialog.unsavedBeforeExitMessage", { count: dirty.length, names }),
    saveText: t("common.saveAllAndClose"),
    discardText: t("common.closeWithoutSaving"),
    cancelText: t("common.cancel"),
  });
  if (choice === "cancel") return "cancel";
  if (choice === "discard") {
    for (const tab of dirty) {
      if (!tab.path) tabsStore.updateContent(tab.id, "");
    }
    return "discard";
  }

  for (const tab of dirty) {
    const ok = await saveBeforeClose(tab.id, tab);
    if (!ok) return "cancel";
  }
  return "save";
}

// 退出前：先问未保存改动（上面），再写草稿 + 刷新 tabs.json，最后真正关窗
const { onExitRequested } = useExitFlush(tabsStore, {
  resolveUnsaved: resolveUnsavedOnExit,
});

/**
 * 关窗 / 退出入口（#442）：设置页覆盖时先确认它的未保存草稿。
 * 取消时必须显式 cancel_close —— Rust 侧已登记本窗口的关闭流程，
 * 不复位的话下次点关闭会被直接吞掉。
 */
async function onExitRequestedWithSettings(): Promise<void> {
  if (!(await confirmSettingsClosed())) {
    try {
      await invoke("cancel_close");
    } catch (err) {
      console.error("[Murasaki] cancel_close 失败:", err);
    }
    return;
  }
  await onExitRequested();
}

/** 启动编排句柄：onBeforeUnmount 时统一撤销监听与后台任务 */
let startup: AppStartupHandle | null = null;

/** E2E 测试钩子（与启动流程无关，启动末尾暴露） */
function exposeTestHooks(): void {
  // 桌面应用 WebView 内部仅应用代码可访问，无 XSS 风险
  // 测试通过 window.__editorRef__.getView() 直接调用 CodeMirror API
  // 注意：editorRef 是 Vue ref，EditorPane 用 v-else 渲染（无 tab 时不挂载）
  // 所以必须用动态 getter，否则注册时 editorRef.value 还是 null
  // 同时暴露 undo/redo：release 构建后浏览器内 dynamic import 路径不可用
  window.__editorRef__ = {
    getView: () => editorRef.value?.getView() ?? null,
    scrollToLine: (line: number) => editorRef.value?.scrollToLine(line),
    focus: () => editorRef.value?.focus(),
    undo: () => {
      const view = editorRef.value?.getView();
      if (view) {
        view.focus();
        cmUndo(view);
      }
    },
    redo: () => {
      const view = editorRef.value?.getView();
      if (view) {
        view.focus();
        cmRedo(view);
      }
    },
  };
  // E2E test hooks：release 构建后 dynamic import 不可用，暴露纯函数/设置器供测试调用
  window.__exportHtml__ = exportHtml;
  window.__setTheme__ = (theme: string) => {
    currentTheme.value = theme;
  };
  window.__setSidebarView__ = (view: SidebarView) => {
    sidebarView.value = view;
  };
  // 暴露 settingsLogic 纯函数：设置窗口未打开时主窗口也能被 E2E 测试访问到
  window.__settingsLogic__ = {
    fieldsForCategory,
    isDirty,
    isCategoryDirty,
    restoreCategoryDefaults,
  };
}

onMounted(async () => {
  // 启动顺序见 useAppStartup：设置 → 待打开路径 → 恢复会话 → 监听 → 就绪
  startup = await bootstrapApp({
    initialized,
    persistence: {
      loadSettings: () => persistence.loadSettings(),
      loadRecent: () => persistence.loadRecent(),
      updateSettings: (patch) => persistence.updateSettings(patch),
      // getter：loadSettings 会整体替换 settings 对象，必须在加载之后读取
      getSettings: () => persistence.settings,
      isLanguageEmpty: () => persistence.languageEmpty,
    },
    applyTheme: (theme) => {
      currentTheme.value = theme;
    },
    applyReadingFont: (preset) => applyReadingFontPreset(preset),
    applyEditorMode: (mode) => editorBridge.setEditorMode(mode),
    sidebar: {
      setView: (view) => {
        sidebarView.value = view;
      },
      restore: (saved) => layout.restore(saved),
    },
    i18n: {
      setLocale,
      mapSystemLocale,
      reloadMenu: (lang) => invoke("reload_menu", { lang }),
      updateShortcutLabels: (overrides) =>
        invoke("update_shortcut_labels", { overrides: toMenuAccelerators(overrides) }),
    },
    detectSystemLocale: () => invoke<string>("detect_system_locale"),
    takePendingOpenPath: () =>
      invoke<{ path: string; type: "file" | "folder" } | null>("take_pending_open_path"),
    openWorkspace: (path) => workspace.openWorkspace(path),
    restoreTabs: () => tabsStore.restore(),
    setupEventListeners,
    // 必须用窗口级 listen：裸 listen 的 target 是 Any，多窗口下会收到所有窗口的 emit（ADR-0017）
    listenCloseRequested: (handler) =>
      getCurrentWebviewWindow().listen("app-close-requested", () => handler()),
    syncRecentMenu,
    onKeyDown,
    onWindowFocus,
    startFileWatcher: () => fileWatcher.start(),
    stopFileWatcher: () => fileWatcher.stop(),
    setupImagePaste: () => imagePaste.setup(),
    teardownImagePaste: () => imagePaste.teardown(),
    setupDragDrop,
    teardownDragDrop,
    setConflictResolver: () => fileOps.setConflictResolver(askConflict),
    clearConflictResolver: () => fileOps.setConflictResolver(null),
    onExitRequested: onExitRequestedWithSettings,
    openPath: (path, type) => {
      void onOpenPath(path, type);
    },
    checkForUpdates: (silent) => {
      void checkForUpdate(silent);
    },
    // E2E 就绪信号：必须晚于「恢复设置 / 工作区 / 标签」（#315）
    markAppReady: () => {
      window.__appReady__ = true;
    },
    exposeTestHooks,
  });
});

onBeforeUnmount(() => {
  // 撤销启动时注册的事件监听、快捷键、文件监听、粘贴 / 拖放与冲突解决器
  startup?.dispose();
  startup = null;
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
  // 工作区内结构变化（外部新建/删除/重命名）→ 刷新文件树
  onTreeChange: () => {
    void workspace.refreshTree();
  },
});

/** 焦点兜底刷新节流窗口（毫秒）：避免窗口频繁获得焦点时反复全量重扫 */
const FOCUS_TREE_REFRESH_THROTTLE_MS = 2000;
let lastFocusTreeRefreshAt = 0;

/** 窗口重新获得焦点 → 兜底刷新文件树（watcher 事件缺失时的保底） */
function onWindowFocus(): void {
  if (!workspace.workspacePath) return;
  const now = Date.now();
  if (now - lastFocusTreeRefreshAt < FOCUS_TREE_REFRESH_THROTTLE_MS) return;
  lastFocusTreeRefreshAt = now;
  // 顺带把文件监听重新装一遍：watcher 可能已经哑掉（工作区目录在外部被删 / 重建，
  // 见 #311），而「路径没变」不足以证明它还活着 —— 重新注册是前端唯一可靠的判据。
  // 目录被换掉时不会触发任何 workspacePath 变化，只能借这里（或下次打开工作区）恢复。
  void fileWatcher.start();
  void workspace.refreshTree();
}

// ===== 图片粘贴/拖入处理 =====
const imagePaste = useImagePaste({
  getEditorView: () => editorRef.value?.getView() ?? null,
  getWorkspacePath: () => workspace.workspacePath,
  getCurrentFilePath: () => activeTab.value?.path ?? null,
  // issue #151：插入方式与落盘目录由设置决定（Alt 临时切换、无工作区自动内嵌在 composable 内处理）
  getInsertMode: () => persistence.settings.imageInsertMode,
  getImageDir: () => persistence.settings.defaultImageDir,
});

/**
 * 外部拖入图片 → 插入当前窗口编辑器（issue #288，由 useDragDrop 的原生拖放链路调用）。
 * `position` 是 Tauri 给的窗口物理像素落点，换算/回退光标都在 composable 内处理。
 */
function onDropImages(paths: string[], position: { x: number; y: number } | null): Promise<void> {
  return imagePaste.insertDroppedImages(paths, position).then(() => undefined);
}

// ===== 编辑器导航/插入 composable =====
const { onJumpToLine, onDropImagePath, onEditorContextAction, onTableInsertConfirm } =
  useEditorNavigation({ editorRef, imagePaste, tableDialogVisible, dialog });

// ===== 全屏切换 =====
async function toggleFullscreen(): Promise<void> {
  try {
    const win = getCurrentWebviewWindow();
    // 以窗口的真实全屏状态为准，而不是自己记一个 ref —— 一旦状态被别的入口改过
    // （系统快捷键、其它窗口操作），本地 ref 就会失真，表现为「按了没反应」。
    const next = !(await win.isFullscreen());
    await win.setFullscreen(next);
    // 全屏时自动隐藏状态栏、退出全屏时恢复（spec 第 51 条）
    statusBarVisible.value = !next;
  } catch (err) {
    console.error("切换全屏失败:", err);
  }
}

// ===== 命令分发（菜单事件 + 全局快捷键）=====
// 快捷键系统：读取 settings.shortcuts 覆盖，提供全局 keydown 匹配
const { matchGlobalKeydown } = useShortcuts();
const { handleMenuEvent, onKeyDown } = useCommands({
  onNewTab,
  openFileViaDialog,
  saveCurrentFile,
  saveAsCurrentFile,
  reloadCurrentFile,
  exportCurrentHtml,
  exportCurrentPdf,
  copyRichText,
  onCloseTabRequest,
  workspace,
  tabsStore,
  searchStore,
  fileOps,
  dialog,
  editorRef,
  currentTheme,
  selectSidebarView,
  statusBarVisible,
  tableDialogVisible,
  allTabsOpen,
  openSettings,
  toggleFullscreen,
  updater: { check: checkForUpdate },
  matchGlobalKeydown,
  setEditorMode: onSelectMode,
  zoomIn,
  zoomOut,
  zoomReset,
  isSettingsVisible: () => settingsVisible.value,
  quitApp,
});

// ===== 拖拽/命令行打开文件或文件夹（issue #92 / #113）=====
// 分类处理：图片 → 复制到 assets 并插入编辑器；文件夹 → 设为工作区；其他 → 打开为 tab
function onOpenPath(path: string, type: "file" | "folder"): Promise<void> {
  if (type === "folder") {
    return workspace.openWorkspace(path);
  }
  // 图片 → 按当前插入方式落到工作区或内嵌；其它 → 打开为 tab
  if (isImageFile(path)) {
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
    // #387：dirty tab 的磁盘行号不可信，按内存内容对搜索词重新定位
    const tab = tabsStore.tabs.find((t) => t.id === entry.tabId);
    const line = resolveSearchJumpLine({
      entry,
      isDirty: tab?.isDirty ?? false,
      content: tab?.content ?? "",
      query: searchStore.query,
      caseSensitive: searchStore.options.caseSensitive,
    });
    if (line !== undefined) {
      requestAnimationFrame(() => {
        editorRef.value?.scrollToLine(line);
        editorRef.value?.focus();
      });
    }
    return;
  }
  // 未保存标签（path=null）无法打开
  if (!entry.path) return;
  await openFile(entry.path);
  // 内容命中 → 打开后跳转到命中行（刚从磁盘读入，行号可信）
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
  currentTheme,
  sidebarView,
  settingsVisible,
  handleMenuEvent,
  onOpenRecent,
});

// ===== 侧栏布局（状态 / 拖拽 / 持久化，见 useSidebarLayout）=====
const layout = useSidebarLayout({
  initialized,
  updateSettings: (patch) => persistence.updateSettings(patch),
});
const sidebarCollapsed = layout.collapsed;
const sidebarDragging = layout.dragging;
const sidebarStyle = layout.style;
const startResize = layout.startResize;

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
  <NConfigProvider
    :theme="naiveTheme"
    :theme-overrides="naiveThemeOverrides"
    :locale="null"
    :date-locale="null"
  >
    <!-- 设置页覆盖时整个应用外壳 inert：键盘焦点、点击与编辑器快捷键都到不了背后文档（#442） -->
    <div
      class="murasaki-shell"
      :class="{ 'has-sidebar': workspace.hasWorkspace || tabsStore.hasTabs }"
      :inert="settingsVisible ? true : undefined"
    >
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
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path
                d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"
              />
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
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
          </button>
          <div class="sidebar-rail-spacer"></div>
          <button
            class="sidebar-rail-btn"
            type="button"
            :title="$t('editor.sidebar.expandSidebar')"
            :aria-label="$t('editor.sidebar.expandSidebar')"
            @click="expandRail"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="9 18 15 12 9 6" />
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
            @click="collapseSidebar"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="15 18 9 12 15 6" />
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
            v-model:all-tabs-open="allTabsOpen"
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
            @new-file="onNewFileFromWelcome"
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
            :zoom="presentationZoom"
            :font-size="persistence.settings.editorFontSize"
            :line-height="persistence.settings.editorLineHeight"
            :font-family="persistence.settings.editorFontFamily"
            :fullwidth-to-markdown="persistence.settings.fullwidthToMarkdown"
            @cursor-change="onCursorChange"
            @open-internal="openFile"
            @drop-image-path="onDropImagePath"
            @open-with-default-app="openWithDefaultApp"
            @context-action="onEditorContextAction"
            @zoom-step="onZoomStep"
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
          :editor-mode="effectiveEditorMode"
          :zoom="presentationZoom"
          @select-mode="onSelectMode"
          @zoom-reset="zoomReset"
        />
      </div>
    </div>

    <!-- 右键菜单容器（全局唯一，数据驱动） -->
    <ContextMenuContainer />

    <!-- 拖放遮罩：外部文件拖到窗口上时提示松开即打开（issue #92） -->
    <Teleport to="body">
      <div v-if="dropDragging" class="murasaki-drop-overlay" aria-hidden="true">
        <div class="murasaki-drop-overlay-card">
          <svg
            width="34"
            height="34"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 3v12" />
            <path d="m7 10 5 5 5-5" />
            <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          </svg>
          <div class="murasaki-drop-overlay-title">{{ $t("common.drop.overlayTitle") }}</div>
          <div class="murasaki-drop-overlay-hint">{{ $t("common.drop.overlayHint") }}</div>
        </div>
      </div>
    </Teleport>

    <!-- 设置页（单入口路由，覆盖主窗口） -->
    <SettingsApp v-if="settingsVisible" ref="settingsRef" @close="settingsVisible = false" />

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

    <!-- 外部修改三选一 / 冲突 / 未保存改动 均由 DialogContainer 统一渲染 -->
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
  transition:
    background var(--murasaki-duration-fast) var(--murasaki-ease),
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
  transition:
    background var(--murasaki-duration-fast) var(--murasaki-ease),
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
  box-shadow: 0 0 0 3px var(--murasaki-primary-soft);
  flex-shrink: 0;
  animation: murasaki-pulse-soft 3.2s ease-in-out infinite;
}

.app-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--murasaki-primary);
  letter-spacing: -0.01em;
}

/* === 拖放遮罩（外部文件拖到窗口上，issue #92） === */
.murasaki-drop-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  pointer-events: none;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--murasaki-primary-soft);
}

.murasaki-drop-overlay-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 26px 40px;
  border-radius: var(--murasaki-radius-lg);
  border: 1.5px dashed var(--murasaki-primary);
  background: var(--murasaki-surface);
  color: var(--murasaki-primary);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18); /* 拖放遮罩卡片投影，一次性，无对应 token */
  animation: murasaki-fade-in var(--murasaki-duration-fast) var(--murasaki-ease-out) both;
}

.murasaki-drop-overlay-title {
  font-size: 16px;
  font-weight: 600;
}

.murasaki-drop-overlay-hint {
  font-size: 12.5px;
  color: var(--murasaki-ink-3);
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
