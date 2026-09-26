import { ref, watch, type Ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { setLocale } from "../i18n";
import { READING_FONT_PRESETS, type ReadingFontPreset, type AppLocale } from "../types";
import { toMenuAccelerators } from "../shortcuts/shortcutsLogic";
import { isMainWindow } from "../utils/windowContext";

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
      shortcuts: Record<string, string | null>;
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
  currentTheme: Ref<string>;
  sidebarView: Ref<"files" | "outline">;
  settingsVisible: Ref<boolean>;
  handleMenuEvent(menuId: string): Promise<void>;
  onOpenRecent(path: string, type: "file" | "folder"): Promise<void>;
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
    currentTheme,
    sidebarView,
    settingsVisible,
    handleMenuEvent,
    onOpenRecent,
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

  // 3. 侧栏视图变化时保存（gated）+ 同步原生「视图 / 文件树视图、大纲视图」勾选
  watch(sidebarView, (v) => {
    if (initialized.value) {
      void persistence.updateSettings({ sidebarView: v });
    }
    void invoke("set_sidebar_view_checked", { viewId: v }).catch((err: unknown) =>
      console.warn("同步侧栏视图菜单勾选失败:", err)
    );
  });

  // 4. 编辑模式设置变更 -> 运行时同步到当前编辑器（不 gated，初始化时也需应用）
  //    同步原生 "视图 / 显示模式" 菜单的互斥勾选
  watch(
    () => persistence.settings.editorMode,
    (mode) => {
      editorBridge.setEditorMode(mode);
      void invoke("set_mode_checked", { modeId: "mode-" + mode });
    }
  );

  // 5. 工作区变化时上报窗口注册表 + 保存（gated）
  watch(
    () => workspace.workspacePath,
    (p) => {
      // 上报「窗口 → 工作区」给 Rust（多窗口同目录聚焦 / 窗口销毁清理，spec #194）
      // 不 gated：窗口恢复工作区时也必须登记，否则重复打开同一文件夹不会聚焦本窗口
      void invoke("set_window_workspace", { path: p }).catch((err: unknown) =>
        console.warn("上报窗口工作区失败:", err)
      );
      if (initialized.value) {
        // lastWorkspacePath 是「上次会话」的全局记忆，只由主窗口写回 ——
        // 否则多窗口会互相覆盖（spec #194 决策 ④ / T2.1）
        if (isMainWindow()) {
          void persistence.updateSettings({ lastWorkspacePath: p });
        }
      }
    }
  );

  // ===== 5 个事件监听器 =====

  /**
   * 注册 5 个 tauri 事件监听器，返回 cleanup 函数。
   * 在 onMounted 中调用，onBeforeUnmount 调用返回的 cleanup。
   */
  async function setupEventListeners(): Promise<() => void> {
    // 前三个事件在 Rust 侧是**定向**发送（`emit_to(label)`），必须用
    // `getCurrentWebviewWindow().listen` 带上 `target: { kind: 'WebviewWindow', label }`。
    // 裸 `listen` 的 target 是 `Any`，Tauri 的 `match_any_or_filter` 让 Any 监听器
    // 匹配一切 emit —— 多窗口下 `emit_to(win-1)` 会被所有窗口收到，于是「保存」
    // 等菜单命令会在每个窗口各执行一次。
    // `settings://saved` 例外：由设置窗口 `emit` 广播，所有窗口都需重载设置，保持裸 listen。
    const unlistenMenu = await getCurrentWebviewWindow().listen<string>("menu-event", (event) => {
      void handleMenuEvent(event.payload);
    });

    const unlistenRecentOpen = await getCurrentWebviewWindow().listen<{
      path: string;
      type: "file" | "folder";
    }>("recent-open", (event) => {
      const { path, type } = event.payload;
      void onOpenRecent(path, type);
    });

    // 注意：不再监听 `single-instance-open-workspace` 与 `open-from-argv`。
    // 多窗口后外部入口（双击文件 / 拖到任务栏 / 命令行传参）由 Rust 直接**新建窗口**，
    // 新窗口的路径统一走 `take_pending_open_path` 拉取模型（spec #194 决策 ①/④），
    // 推送事件在「窗口还没到家」时必然丢失，保留只会留下误导性的单窗口语义。

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
        // 同步显示模式菜单勾选：经 loadSettings 读取的 editorMode 若与当前
        // 相同 watcher 不会触发，故在此补一次保证 "视图 / 显示模式" 勾选正确
        void invoke("set_mode_checked", {
          modeId: "mode-" + persistence.settings.editorMode,
        });
        // 同步快捷键覆盖到原生菜单（菜单项右侧快捷键提示跟随用户自定义）
        void invoke("update_shortcut_labels", {
          overrides: toMenuAccelerators(persistence.settings.shortcuts ?? {}),
        });
      }
    );

    const unlistenNavigate = await getCurrentWebviewWindow().listen<string>("navigate", (event) => {
      settingsVisible.value = event.payload === "settings";
    });

    return () => {
      unlistenMenu();
      unlistenRecentOpen();
      unlistenSettingsSaved();
      unlistenNavigate();
    };
  }

  return {
    initialized,
    setupEventListeners,
  };
}
