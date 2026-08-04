import { describe, it, expect, beforeEach, vi } from "vitest";
import { ref, reactive, effectScope, nextTick } from "vue";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useAppLifecycle, type AppLifecycleDeps } from "./useAppLifecycle";

// ===== Mock @tauri-apps/api/event =====
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

// ===== Mock @tauri-apps/api/core =====
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

const mockedListen = listen as unknown as ReturnType<typeof vi.fn>;
const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

function makeDeps(overrides: Partial<AppLifecycleDeps> = {}): AppLifecycleDeps {
  return {
    tabsStore: reactive({
      tabs: [] as unknown[],
      activeTabId: null as string | null,
      restoring: false,
      persist: vi.fn().mockResolvedValue(undefined),
    }) as never,
    persistence: {
      settings: reactive({
        markdownTheme: "github",
        editorMode: "split" as const,
        sidebarView: "files" as const,
        lastWorkspacePath: null,
        language: "zh-CN" as const,
      }),
      updateSettings: vi.fn().mockResolvedValue(undefined),
      loadSettings: vi.fn().mockResolvedValue(undefined),
    } as never,
    workspace: reactive({
      workspacePath: null as string | null,
      openWorkspace: vi.fn().mockResolvedValue(undefined),
    }) as never,
    editorBridge: {
      setEditorMode: vi.fn(),
    } as never,
    proposalsStore: {
      clearAllForWorkspace: vi.fn(),
    } as never,
    currentTheme: ref("github"),
    sidebarView: ref<"files" | "outline">("files"),
    settingsVisible: ref(false),
    handleMenuEvent: vi.fn().mockResolvedValue(undefined),
    onOpenRecent: vi.fn().mockResolvedValue(undefined),
    onOpenPath: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  mockedListen.mockReset();
  mockedInvoke.mockReset();
  // Default: listen returns an unlisten function
  mockedListen.mockResolvedValue(vi.fn() as unknown as UnlistenFn);
  mockedInvoke.mockResolvedValue(undefined);
});

describe("useAppLifecycle", () => {
  describe("watchers - initialized 门控", () => {
    it("initialized=false 时 theme 变化不触发 updateSettings", async () => {
      const deps = makeDeps();
      const scope = effectScope();
      scope.run(() => {
        const { initialized } = useAppLifecycle(deps);
        // initialized 默认 false
        expect(initialized.value).toBe(false);
        deps.currentTheme.value = "night";
      });
      await nextTick();
      expect(deps.persistence.updateSettings).not.toHaveBeenCalled();
      scope.stop();
    });

    it("initialized=true 时 theme 变化触发 updateSettings + set_theme_checked", async () => {
      const deps = makeDeps();
      const scope = effectScope();
      const { initialized } = scope.run(() => useAppLifecycle(deps))!;
      initialized.value = true;
      await nextTick();

      deps.currentTheme.value = "night";
      await nextTick();

      expect(deps.persistence.updateSettings).toHaveBeenCalledWith({
        markdownTheme: "night",
      });
      expect(mockedInvoke).toHaveBeenCalledWith("set_theme_checked", {
        themeId: "theme-night",
      });
      scope.stop();
    });

    it("initialized=true 时 sidebarView 变化触发 updateSettings", async () => {
      const deps = makeDeps();
      const scope = effectScope();
      const { initialized } = scope.run(() => useAppLifecycle(deps))!;
      initialized.value = true;
      await nextTick();

      deps.sidebarView.value = "outline";
      await nextTick();

      expect(deps.persistence.updateSettings).toHaveBeenCalledWith({
        sidebarView: "outline",
      });
      scope.stop();
    });

    it("initialized=true 时 workspacePath 变化触发 updateSettings + clearAllForWorkspace", async () => {
      const deps = makeDeps();
      const scope = effectScope();
      const { initialized } = scope.run(() => useAppLifecycle(deps))!;
      initialized.value = true;
      await nextTick();

      deps.workspace.workspacePath = "/new/workspace";
      await nextTick();

      expect(deps.persistence.updateSettings).toHaveBeenCalledWith({
        lastWorkspacePath: "/new/workspace",
      });
      expect(deps.proposalsStore.clearAllForWorkspace).toHaveBeenCalled();
      scope.stop();
    });

    it("editorMode 变化始终触发 setEditorMode（不受 initialized 门控）", async () => {
      const deps = makeDeps();
      const scope = effectScope();
      scope.run(() => {
        useAppLifecycle(deps);
      });
      // initialized 仍为 false，但 editorMode 不受门控
      deps.persistence.settings.editorMode = "wysiwyg";
      await nextTick();

      expect(deps.editorBridge.setEditorMode).toHaveBeenCalledWith("wysiwyg");
      scope.stop();
    });
  });

  describe("setupEventListeners", () => {
    it("注册 6 个事件监听器并返回 cleanup 函数", async () => {
      const deps = makeDeps();
      const scope = effectScope();
      const { setupEventListeners } = scope.run(() => useAppLifecycle(deps))!;

      const cleanup = await setupEventListeners();

      expect(mockedListen).toHaveBeenCalledTimes(6);
      expect(mockedListen).toHaveBeenCalledWith("menu-event", expect.any(Function));
      expect(mockedListen).toHaveBeenCalledWith("recent-open", expect.any(Function));
      expect(mockedListen).toHaveBeenCalledWith(
        "single-instance-open-workspace",
        expect.any(Function)
      );
      expect(mockedListen).toHaveBeenCalledWith("open-from-argv", expect.any(Function));
      expect(mockedListen).toHaveBeenCalledWith("settings://saved", expect.any(Function));
      expect(mockedListen).toHaveBeenCalledWith("navigate", expect.any(Function));

      // cleanup 调用所有 unlisten
      expect(typeof cleanup).toBe("function");
      cleanup();
      scope.stop();
    });

    it("menu-event 触发 handleMenuEvent", async () => {
      const deps = makeDeps();
      const scope = effectScope();
      const { setupEventListeners } = scope.run(() => useAppLifecycle(deps))!;

      let menuHandler: ((e: { payload: string }) => void) | null = null;
      mockedListen.mockImplementation((event: string, cb: (e: { payload: string }) => void) => {
        if (event === "menu-event") menuHandler = cb;
        return Promise.resolve(vi.fn() as unknown as UnlistenFn);
      });

      await setupEventListeners();
      menuHandler!({ payload: "save" });

      expect(deps.handleMenuEvent).toHaveBeenCalledWith("save");
      scope.stop();
    });

    it("navigate 事件切换 settingsVisible", async () => {
      const deps = makeDeps();
      const scope = effectScope();
      const { setupEventListeners } = scope.run(() => useAppLifecycle(deps))!;

      let navHandler: ((e: { payload: string }) => void) | null = null;
      mockedListen.mockImplementation((event: string, cb: (e: { payload: string }) => void) => {
        if (event === "navigate") navHandler = cb;
        return Promise.resolve(vi.fn() as unknown as UnlistenFn);
      });

      await setupEventListeners();
      navHandler!({ payload: "settings" });
      expect(deps.settingsVisible.value).toBe(true);

      navHandler!({ payload: "editor" });
      expect(deps.settingsVisible.value).toBe(false);
      scope.stop();
    });
  });
});
