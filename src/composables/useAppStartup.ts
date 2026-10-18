/**
 * 应用启动编排（#433）。
 *
 * `App.vue` 的 onMounted 原本是一段 130 行的顺序脚本，启动次序只存在于注释里：
 * 设置 → 待打开路径 → 恢复工作区/标签 → 事件监听 → 快捷键 → 文件监听 → 拖放 → 就绪。
 * 抽到这里后，顺序是可以逐行读、也可以被单测断言的一份清单。
 *
 * 约定：
 * - 所有副作用都通过 `deps` 注入，本模块不直接 import store / tauri API；
 * - 每一步保持原有语义与顺序，行为不变（验收：行为不变，前端单测与 e2e 全绿）；
 * - 返回的 `dispose()` 负责撤销本模块注册的所有监听与后台任务。
 */
import type { Ref } from "vue";
import type { AppLocale, EditorMode, ReadingFontPreset, SidebarView } from "../types";

export interface StartupSettings {
  markdownTheme: string;
  editorMode: EditorMode;
  editorFontPreset: ReadingFontPreset;
  sidebarView: SidebarView;
  sidebarWidth?: number;
  sidebarCollapsed: boolean;
  reopenLastWorkspace: boolean;
  lastWorkspacePath: string | null;
  checkUpdatesOnStartup: boolean;
  shortcuts?: Record<string, string | null>;
  language: AppLocale;
}

export interface AppStartupDeps {
  /** 初始化完成标志：置 true 后，各 watcher 才开始把状态写回持久化 */
  initialized: Ref<boolean>;
  persistence: {
    loadSettings(): Promise<unknown>;
    loadRecent(): Promise<unknown>;
    updateSettings(patch: Record<string, unknown>): Promise<unknown>;
    settings: StartupSettings;
    /** 从未写入过 language（首次启动，需要探测系统语言） */
    languageEmpty: boolean;
  };
  applyTheme(theme: string): void;
  applyReadingFont(preset: ReadingFontPreset): void;
  applyEditorMode(mode: EditorMode): void;
  sidebar: {
    setView(view: SidebarView): void;
    restore(layout: { width?: number; collapsed: boolean }): void;
  };
  i18n: {
    setLocale(locale: AppLocale): void;
    mapSystemLocale(system: string): AppLocale;
    reloadMenu(locale: AppLocale): void | Promise<unknown>;
    updateShortcutLabels(overrides: Record<string, string | null>): void | Promise<unknown>;
  };
  detectSystemLocale(): Promise<string>;
  takePendingOpenPath(): Promise<{ path: string; type?: string } | null>;
  openWorkspace(path: string): Promise<unknown>;
  restoreTabs(): Promise<unknown>;
  setupEventListeners(): Promise<() => void>;
  listenCloseRequested(handler: () => void): Promise<() => void>;
  syncRecentMenu(): Promise<unknown>;
  /** 全局快捷键处理（注册 / 注销由本模块负责） */
  onKeyDown(event: KeyboardEvent): void;
  /** 窗口获得焦点时的兜底刷新 */
  onWindowFocus(): void;
  startFileWatcher(): void;
  stopFileWatcher(): void;
  setupImagePaste(): void;
  teardownImagePaste(): void;
  setupDragDrop(): Promise<void>;
  teardownDragDrop(): void;
  setConflictResolver(): void;
  clearConflictResolver(): void;
  onExitRequested(): void;
  openPath(path: string, type: "file" | "folder"): void;
  checkForUpdates(silent: boolean): void;
  /** 置 `window.__appReady__`（E2E 就绪判据，必须晚于会话恢复） */
  markAppReady(): void;
  /** 暴露 E2E 测试钩子（最后一步，与启动流程无关） */
  exposeTestHooks(): void;
}

export interface AppStartupHandle {
  /** 撤销本模块注册的所有监听与后台任务（幂等） */
  dispose(): void;
}

/**
 * 执行启动流程。顺序：
 *
 * 1. 读设置 / 最近打开，应用主题、字体、编辑模式、语言、侧栏布局
 * 2. 取本窗口的待打开路径（take-and-clear，必须在会话恢复之前）
 * 3. 无待打开路径时，恢复上次工作区与标签
 * 4. 注册事件监听（菜单、最近打开、设置保存、导航）与关窗拦截
 * 5. 同步最近打开菜单、注册全局快捷键与文件监听
 * 6. 图片粘贴、原生拖放、冲突解决器
 * 7. 标记初始化完成（E2E 就绪信号）
 * 8. 打开待打开路径（此时监听已就绪，不会漏事件）
 * 9. 启动时静默检查更新
 */
export async function bootstrapApp(deps: AppStartupDeps): Promise<AppStartupHandle> {
  const cleanups: Array<() => void> = [];
  const dispose = (): void => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch (err) {
        console.error("[Murasaki] 启动清理失败:", err);
      }
    }
  };

  // ===== 1. 持久化状态 =====
  await deps.persistence.loadSettings();
  await deps.persistence.loadRecent();

  const settings = deps.persistence.settings;
  if (settings.markdownTheme) deps.applyTheme(settings.markdownTheme);
  deps.applyReadingFont(settings.editorFontPreset);
  deps.applyEditorMode(settings.editorMode);

  // 首次启动（language 从未写入）探测系统语言并持久化；既有用户保持原设置
  let effectiveLanguage: AppLocale = settings.language;
  if (deps.persistence.languageEmpty) {
    try {
      const detected = await deps.detectSystemLocale();
      effectiveLanguage = deps.i18n.mapSystemLocale(detected);
      await deps.persistence.updateSettings({ language: effectiveLanguage });
    } catch (err) {
      console.warn("探测系统语言失败，使用默认语言:", err);
    }
  }
  deps.i18n.setLocale(effectiveLanguage);
  Promise.resolve(deps.i18n.reloadMenu(effectiveLanguage)).catch((err: unknown) =>
    console.warn("初始化菜单语言失败:", err)
  );
  Promise.resolve(deps.i18n.updateShortcutLabels(settings.shortcuts ?? {})).catch(
    (err: unknown) => console.warn("初始化菜单快捷键失败:", err)
  );

  deps.sidebar.setView(settings.sidebarView);
  deps.sidebar.restore({
    width: settings.sidebarWidth,
    collapsed: settings.sidebarCollapsed,
  });

  // ===== 2. 待打开路径（take-and-clear，必须在恢复之前）=====
  let pendingOpen: { path: string; type: "file" | "folder" } | null = null;
  try {
    const pending = await deps.takePendingOpenPath();
    if (pending?.path) {
      pendingOpen = {
        path: pending.path,
        type: pending.type === "folder" ? "folder" : "file",
      };
      console.log("[Murasaki] 本窗口由外部入口创建，跳过上次会话恢复:", pendingOpen.path);
    }
  } catch (err) {
    console.warn("[Murasaki] 读取启动参数路径失败:", err);
  }

  // ===== 3. 恢复上次会话（仅正常启动）=====
  if (!pendingOpen) {
    if (settings.reopenLastWorkspace && settings.lastWorkspacePath) {
      try {
        await deps.openWorkspace(settings.lastWorkspacePath);
      } catch (err) {
        console.warn("[Murasaki] 恢复工作区失败:", err);
      }
    }
    await deps.restoreTabs();
  }

  // ===== 4. 事件监听与关窗拦截 =====
  const disposeListeners = await deps.setupEventListeners();
  cleanups.push(disposeListeners);
  const disposeClose = await deps.listenCloseRequested(deps.onExitRequested);
  cleanups.push(disposeClose);

  // ===== 5. 菜单同步、快捷键、文件监听 =====
  await deps.syncRecentMenu();

  window.addEventListener("keydown", deps.onKeyDown);
  cleanups.push(() => window.removeEventListener("keydown", deps.onKeyDown));

  deps.startFileWatcher();
  cleanups.push(() => deps.stopFileWatcher());

  window.addEventListener("focus", deps.onWindowFocus);
  cleanups.push(() => window.removeEventListener("focus", deps.onWindowFocus));

  // ===== 6. 图片粘贴、拖放、冲突解决器 =====
  deps.setupImagePaste();
  cleanups.push(() => deps.teardownImagePaste());

  try {
    await deps.setupDragDrop();
  } catch (err) {
    // IPC 边界：注册失败不应阻断后续接线
    console.error("注册拖放监听失败:", err);
  }
  cleanups.push(() => deps.teardownDragDrop());

  deps.setConflictResolver();
  cleanups.push(() => deps.clearConflictResolver());

  // ===== 7. 初始化完成（watcher 开始落盘；E2E 就绪信号）=====
  deps.initialized.value = true;
  deps.markAppReady();
  deps.exposeTestHooks();

  // ===== 8. 打开待打开路径（监听已就绪）=====
  if (pendingOpen) {
    deps.openPath(pendingOpen.path, pendingOpen.type);
  }

  // ===== 9. 启动时静默检查更新 =====
  if (settings.checkUpdatesOnStartup) {
    deps.checkForUpdates(true);
  }

  return { dispose };
}
