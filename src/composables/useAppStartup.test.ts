import { describe, it, expect, vi } from "vitest";
import { ref, type Ref } from "vue";
import { bootstrapApp, type AppStartupDeps, type StartupSettings } from "./useAppStartup";

/**
 * #433：启动编排。
 *
 * 这些用例把「启动顺序」变成可断言的清单 —— 顺序一旦被改动，
 * 测试会明确指出哪一步换了位置（App.vue 里以前只能靠注释）。
 */
function settingsOf(overrides: Partial<StartupSettings> = {}): StartupSettings {
  return {
    markdownTheme: "murasaki",
    editorMode: "split",
    editorFontPreset: "d",
    sidebarView: "files",
    sidebarCollapsed: false,
    reopenLastWorkspace: true,
    lastWorkspacePath: "C:/ws",
    checkUpdatesOnStartup: true,
    language: "zh-CN",
    ...overrides,
  };
}

function makeDeps(
  options: {
    settings?: Partial<StartupSettings>;
    /** loadSettings 之后 store 里的设置（模拟 store 整体替换 settings 对象） */
    settingsAfterLoad?: Partial<StartupSettings>;
    languageEmpty?: boolean;
    pending?: { path: string; type?: string } | null;
    setupDragDrop?: () => Promise<void>;
    failAt?: string;
  } = {}
): { deps: AppStartupDeps; calls: string[]; initialized: Ref<boolean> } {
  const calls: string[] = [];
  const record = (name: string) => vi.fn(async () => {
    calls.push(name);
    if (options.failAt === name) throw new Error(`fail at ${name}`);
  });
  const initialized = ref(false);
  let currentSettings = settingsOf(options.settings);
  const deps: AppStartupDeps = {
    initialized,
    persistence: {
      loadSettings: vi.fn(async () => {
        calls.push("loadSettings");
        if (options.settingsAfterLoad) {
          currentSettings = settingsOf(options.settingsAfterLoad);
        }
      }),
      loadRecent: record("loadRecent"),
      updateSettings: vi.fn(async () => undefined),
      getSettings: () => currentSettings,
      isLanguageEmpty: () => options.languageEmpty ?? false,
    },
    applyTheme: vi.fn(() => calls.push("applyTheme")),
    applyReadingFont: vi.fn(() => calls.push("applyReadingFont")),
    applyEditorMode: vi.fn(() => calls.push("applyEditorMode")),
    sidebar: {
      setView: vi.fn(() => calls.push("setSidebarView")),
      restore: vi.fn(() => calls.push("restoreSidebarLayout")),
    },
    i18n: {
      setLocale: vi.fn(() => calls.push("setLocale")),
      mapSystemLocale: vi.fn(() => "en" as const),
      reloadMenu: vi.fn(() => {
        calls.push("reloadMenu");
      }),
      updateShortcutLabels: vi.fn(() => {
        calls.push("updateShortcutLabels");
      }),
    },
    detectSystemLocale: vi.fn(async () => {
      calls.push("detectSystemLocale");
      return "en-US";
    }),
    takePendingOpenPath: vi.fn(async () => {
      calls.push("takePendingOpenPath");
      return options.pending ?? null;
    }),
    openWorkspace: record("openWorkspace"),
    restoreTabs: record("restoreTabs"),
    notifyRestoreFailure: vi.fn((path: string) => calls.push(`notifyRestoreFailure:${path}`)),
    setupEventListeners: vi.fn(async () => {
      calls.push("setupEventListeners");
      return () => calls.push("disposeListeners");
    }),
    listenCloseRequested: vi.fn(async () => {
      calls.push("listenCloseRequested");
      return () => calls.push("disposeCloseListener");
    }),
    syncRecentMenu: record("syncRecentMenu"),
    onKeyDown: vi.fn(),
    onWindowFocus: vi.fn(),
    startFileWatcher: vi.fn(() => calls.push("startFileWatcher")),
    stopFileWatcher: vi.fn(() => calls.push("stopFileWatcher")),
    setupImagePaste: vi.fn(() => calls.push("setupImagePaste")),
    teardownImagePaste: vi.fn(() => calls.push("teardownImagePaste")),
    setupDragDrop:
      options.setupDragDrop ??
      vi.fn(async () => {
        calls.push("setupDragDrop");
      }),
    teardownDragDrop: vi.fn(() => calls.push("teardownDragDrop")),
    setConflictResolver: vi.fn(() => calls.push("setConflictResolver")),
    clearConflictResolver: vi.fn(() => calls.push("clearConflictResolver")),
    onExitRequested: vi.fn(),
    openPath: vi.fn(() => calls.push("openPath")),
    checkForUpdates: vi.fn(() => calls.push("checkForUpdates")),
    markAppReady: vi.fn(() => calls.push("markAppReady")),
    exposeTestHooks: vi.fn(() => calls.push("exposeTestHooks")),
  };
  return { deps, calls, initialized };
}

describe("bootstrapApp", () => {
  it("正常启动：按固定顺序执行，最后标记就绪", async () => {
    const { deps, calls, initialized } = makeDeps();

    await bootstrapApp(deps);

    expect(calls).toEqual([
      "loadSettings",
      "loadRecent",
      "applyTheme",
      "applyReadingFont",
      "applyEditorMode",
      "setLocale",
      "reloadMenu",
      "updateShortcutLabels",
      "setSidebarView",
      "restoreSidebarLayout",
      "takePendingOpenPath",
      "openWorkspace",
      "restoreTabs",
      "setupEventListeners",
      "listenCloseRequested",
      "syncRecentMenu",
      "startFileWatcher",
      "setupImagePaste",
      "setupDragDrop",
      "setConflictResolver",
      "markAppReady",
      "checkForUpdates",
      "exposeTestHooks",
    ]);
    expect(initialized.value).toBe(true);
  });

  it("设置在 loadSettings 之后读取（避免用默认值启动）", async () => {
    const { deps } = makeDeps({
      settings: { markdownTheme: "murasaki" },
      settingsAfterLoad: {
        markdownTheme: "night",
        editorMode: "source",
        lastWorkspacePath: "C:/saved",
      },
    });

    await bootstrapApp(deps);

    expect(deps.applyTheme).toHaveBeenCalledWith("night");
    expect(deps.applyEditorMode).toHaveBeenCalledWith("source");
    expect(deps.openWorkspace).toHaveBeenCalledWith("C:/saved");
  });

  it("恢复工作区失败时给出用户可见提示（#436）", async () => {
    const { deps, calls } = makeDeps({
      settings: { reopenLastWorkspace: true, lastWorkspacePath: "C:/gone" },
      failAt: "openWorkspace",
    });

    await bootstrapApp(deps);

    expect(calls).toContain("notifyRestoreFailure:C:/gone");
    // 恢复失败不应阻断后续启动步骤
    expect(calls).toContain("restoreTabs");
    expect(calls).toContain("setupEventListeners");
  });

  it("有外部入口的待打开路径：跳过会话恢复，监听就绪后才打开", async () => {
    const { deps, calls } = makeDeps({
      pending: { path: "C:/ws/a.md", type: "file" },
    });

    await bootstrapApp(deps);

    expect(calls).not.toContain("openWorkspace");
    expect(calls).not.toContain("restoreTabs");
    // 打开动作必须在监听注册与就绪标记之后
    expect(calls.indexOf("openPath")).toBeGreaterThan(calls.indexOf("markAppReady"));
    expect(deps.openPath).toHaveBeenCalledWith("C:/ws/a.md", "file");
  });

  it("首次启动：探测系统语言并写回设置", async () => {
    const { deps } = makeDeps({ languageEmpty: true });

    await bootstrapApp(deps);

    expect(deps.detectSystemLocale).toHaveBeenCalled();
    expect(deps.persistence.updateSettings).toHaveBeenCalledWith({ language: "en" });
  });

  it("关闭「恢复上次工作区」时仍恢复标签", async () => {
    const { deps, calls } = makeDeps({
      settings: { reopenLastWorkspace: false },
    });

    await bootstrapApp(deps);

    expect(calls).not.toContain("openWorkspace");
    expect(calls).toContain("restoreTabs");
  });

  it("拖放注册失败不阻断后续步骤", async () => {
    const { deps, calls, initialized } = makeDeps({
      setupDragDrop: vi.fn(async () => {
        throw new Error("no ipc");
      }),
    });

    await bootstrapApp(deps);

    expect(calls).toContain("setConflictResolver");
    expect(initialized.value).toBe(true);
  });

  it("中途失败时撤销已注册的监听并抛出", async () => {
    const { deps, calls } = makeDeps({ failAt: "syncRecentMenu" });

    await expect(bootstrapApp(deps)).rejects.toThrow("fail at syncRecentMenu");

    expect(calls).toContain("disposeCloseListener");
    expect(calls).toContain("disposeListeners");
    expect(calls).not.toContain("startFileWatcher");
  });

  it("dispose 按注册的逆序撤销监听与后台任务", async () => {
    const { deps, calls } = makeDeps();
    const handle = await bootstrapApp(deps);

    handle.dispose();

    expect(calls.slice(calls.indexOf("clearConflictResolver"))).toEqual([
      "clearConflictResolver",
      "teardownDragDrop",
      "teardownImagePaste",
      "stopFileWatcher",
      "disposeCloseListener",
      "disposeListeners",
    ]);
  });
});
