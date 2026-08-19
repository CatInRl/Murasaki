import { ref, watch, type Ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { setLocale } from "../i18n";
import { READING_FONT_PRESETS, type ReadingFontPreset, type AppLocale } from "../types";

/** useAppLifecycle 依赖的 store/状态切片 */
export interface AppLifecycleDeps {
  tabsStore: {
    /** Pinia store 暴露的未包装 state；watcher 通过 getter 访问以跟踪响应式 */
    tabs: readonly unknown[];
    activeTabId: string | null;
    /** 是否正在从持久化恢复（true 时 watcher 跳过 persist，避免覆盖 tabs.json） */
    restoring: boolean;
    persist(): Promise<unknown>;
  };
  persistence: {
    settings: {
      markdownTheme: string;
      editorMode: string;
      editorFontPreset: ReadingFontPreset;
      sidebarView: "files" | "outline";
      lastWorkspacePath: string | null;
      language: AppLocale;
    };
    updateSettings(patch: Record<string, unknown>): Promise<unknown>;
    loadSettings(): Promise<unknown>;
  };
  workspace: {
    /** Pinia store 暴露的未包装 state；watcher 通过 getter 访问以跟踪响应式 */
    workspacePath: string | null;
    openWorkspace(path: string): Promise<unknown>;
  };
  editorBridge: {
    /** 方法语法（bivariant）以兼容 store 的 EditorMode 参数 */
    setEditorMode(mode: string): void;
  };
  proposalsStore: {
    clearAllForWorkspace(): void;
  };
  currentTheme: Ref<string>;
  sidebarView: Ref<"files" | "outline">;
  settingsVisible: Ref<boolean>;
  handleMenuEvent(menuId: string): Promise<void>;
  onOpenRecent(path: string, type: "file" | "folder"): Promise<void>;
  onOpenPath(path: string, type: "file" | "folder"): Promise<void>;
}

/**
 * 应用生命周期管理：5 个 watcher + 5 个事件监听器。
 *
 * - watcher 在 composable 调用时同步注册，由 `initialized` 门控（除 editorMode）
 * - setupEventListeners() 异步注册 5 个 tauri 事件监听器，返回 cleanup 函数
 * - 调用方负责在 onMounted 末尾将 initialized.value = true
 *   并在 onBeforeUnmount 调用 cleanup()
 *
 * 从 App.vue 提取，保持原有行为不变。
 */
export function useAppLifecycle(deps: AppLifecycleDeps) {
  const {
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
  } = deps;

  const initialized = ref(false);

  // 点亮 --murasaki-font-reading 变量：预览/WYSIWYG 统一使用当前阅读字体预设
  function applyReadingFontPreset(preset: ReadingFontPreset): void {
    document.documentElement.style.setProperty(
      "--murasaki-font-reading",
      READING_FONT_PRESETS[preset] ?? READING_FONT_PRESETS.d
    );
  }

  // ===== 5 个 watcher =====

  // 1. Tab 状态变化时持久化（gated）
  //    restoring=true 时跳过（clearAll/restore 期间不 persist，避免覆盖 tabs.json）
  watch(
    () => [tabsStore.tabs, tabsStore.activeTabId],
    () => {
      if (initialized.value && !tabsStore.restoring) {
        void tabsStore.persist();
      }
    },
    { deep: true }
  );

  // 2. 主题变化时保存 + 同步原生菜单勾选（保存部分 gated，菜单同步始终执行）
  watch(currentTheme, (newTheme) => {
    if (initialized.value) {
      void persistence.updateSettings({ markdownTheme: newTheme });
    }
    // 同步原生主题菜单的勾选状态（菜单点击 / 初始加载 / 设置同步均会触发此 watch）
    void invoke("set_theme_checked", { themeId: "theme-" + newTheme });
  });

  // 3. 侧栏视图变化时保存（gated）
  watch(sidebarView, (v) => {
    if (initialized.value) {
      void persistence.updateSettings({ sidebarView: v });
    }
  });

  // 4. 编辑模式设置变更 -> 运行时同步到当前编辑器（不 gated，初始化时也需应用）
  watch(
    () => persistence.settings.editorMode,
    (mode) => {
      editorBridge.setEditorMode(mode);
    }
  );

  // 5. 工作区变化时保存 + 清空所有提议（gated）
  watch(
    () => workspace.workspacePath,
    (p) => {
      if (initialized.value) {
        void persistence.updateSettings({ lastWorkspacePath: p });
        // 工作区切换时清空所有提议（包括新文件提议）
        // 避免上一个工作区的提议残留导致写入到错误的工作区
        proposalsStore.clearAllForWorkspace();
      }
    }
  );

  // ===== 5 个事件监听器 =====

  /**
   * 注册 5 个 tauri 事件监听器，返回 cleanup 函数。
   * 在 onMounted 中调用，onBeforeUnmount 调用返回的 cleanup。
   */
  async function setupEventListeners(): Promise<() => void> {
    const unlistenMenu = await listen<string>("menu-event", (event) => {
      void handleMenuEvent(event.payload);
    });

    const unlistenRecentOpen = await listen<{
      path: string;
      type: "file" | "folder";
    }>("recent-open", (event) => {
      const { path, type } = event.payload;
      void onOpenRecent(path, type);
    });

    const unlistenSingleInstance = await listen<string>(
      "single-instance-open-workspace",
      (event) => {
        const workspacePath = event.payload;
        if (workspacePath) {
          void workspace.openWorkspace(workspacePath);
        }
      }
    );

    // 打开文件/文件夹路径（issue #92 / #113）
    const unlistenOpenFromArgv = await listen<{
      path: string;
      type: "file" | "folder";
    }>("open-from-argv", (event) => {
      const { path, type } = event.payload;
      if (path) {
        void onOpenPath(path, type === "folder" ? "folder" : "file");
      }
    });

    const unlistenSettingsSaved = await listen<unknown>(
      "settings://saved",
      async () => {
        await persistence.loadSettings();
        // 同步阅读字体预设（--murasaki-font-reading）
        applyReadingFontPreset(persistence.settings.editorFontPreset);
        // 同步主题（currentTheme 不在 watch 监听内，需手动同步）
        if (persistence.settings.markdownTheme) {
          currentTheme.value = persistence.settings.markdownTheme;
          // 显式同步原生菜单勾选状态：设置窗口可能修改了 markdownTheme，
          // 若新值与旧值相同 watch 不会触发，故在此补一次保证菜单勾选正确
          void invoke("set_theme_checked", {
            themeId: "theme-" + persistence.settings.markdownTheme,
          });
        }
        // 同步界面语言：前端 i18n + Rust 原生菜单（ADR-0013）
        // 始终调用，即使值未变也保证前端与 Rust 状态一致
        setLocale(persistence.settings.language);
        void invoke("reload_menu", { lang: persistence.settings.language });
      }
    );

    const unlistenNavigate = await listen<string>("navigate", (event) => {
      settingsVisible.value = event.payload === "settings";
    });

    return () => {
      unlistenMenu();
      unlistenRecentOpen();
      unlistenSingleInstance();
      unlistenOpenFromArgv();
      unlistenSettingsSaved();
      unlistenNavigate();
    };
  }

  return {
    initialized,
    setupEventListeners,
  };
}
