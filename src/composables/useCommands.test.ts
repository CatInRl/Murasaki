import { describe, it, expect, vi } from "vitest";
import { ref } from "vue";
import { useCommands, type CommandsDeps } from "./useCommands";

/**
 * #442：设置页覆盖时的命令拦截 + Ctrl+N 在任意侧栏状态下可见。
 * 这里只覆盖命令分发本身，副作用全部用 spy 替身。
 */
function createDeps() {
  const calls = {
    save: vi.fn(async () => {}),
    newTab: vi.fn(),
    beginRootCreate: vi.fn(),
    selectSidebarView: vi.fn(),
    closeTab: vi.fn(async () => {}),
    quitApp: vi.fn(async () => {}),
    checkUpdates: vi.fn(async () => null),
  };
  const deps: CommandsDeps = {
    onNewTab: calls.newTab,
    openFileViaDialog: vi.fn(async () => {}),
    saveCurrentFile: calls.save,
    saveAsCurrentFile: vi.fn(async () => {}),
    reloadCurrentFile: vi.fn(async () => {}),
    exportCurrentHtml: vi.fn(async () => {}),
    exportCurrentPdf: vi.fn(async () => {}),
    copyRichText: vi.fn(async () => {}),
    onCloseTabRequest: calls.closeTab,
    workspace: {
      openFolderDialog: vi.fn(async () => {}),
      closeWorkspace: vi.fn(),
      hasWorkspace: true,
      workspacePath: "/ws",
    },
    tabsStore: {
      activeTabId: "t1",
      hasTabs: true,
      switchNext: vi.fn(),
      switchPrev: vi.fn(),
    },
    searchStore: { visible: false },
    setEditorMode: vi.fn(async () => {}),
    fileOps: {
      createDirectory: vi.fn(async () => ({})),
      beginRootCreate: calls.beginRootCreate,
    },
    dialog: {
      alert: vi.fn(async () => {}),
      prompt: vi.fn(async () => null),
    },
    editorRef: ref(null) as unknown as CommandsDeps["editorRef"],
    currentTheme: ref("murasaki"),
    selectSidebarView: calls.selectSidebarView,
    statusBarVisible: ref(true),
    tableDialogVisible: ref(false),
    allTabsOpen: ref(false),
    updater: { check: calls.checkUpdates },
    openSettings: vi.fn(async () => {}),
    toggleFullscreen: vi.fn(async () => {}),
    isSettingsVisible: () => false,
    quitApp: calls.quitApp,
    zoomIn: vi.fn(async () => {}),
    zoomOut: vi.fn(async () => {}),
    zoomReset: vi.fn(async () => {}),
    matchGlobalKeydown: () => null,
  };
  return { deps, calls };
}

describe("useCommands (#442)", () => {
  describe("设置页覆盖时", () => {
    it("保存 / 查找 / 关闭标签等文档命令不再执行", async () => {
      const { deps, calls } = createDeps();
      const { handleMenuEvent } = useCommands({
        ...deps,
        isSettingsVisible: () => true,
      });

      await handleMenuEvent("save");
      await handleMenuEvent("save-as");
      await handleMenuEvent("find");
      await handleMenuEvent("replace");
      await handleMenuEvent("close-tab");
      await handleMenuEvent("new-file");

      expect(calls.save).not.toHaveBeenCalled();
      expect(calls.closeTab).not.toHaveBeenCalled();
      expect(calls.newTab).not.toHaveBeenCalled();
      expect(calls.beginRootCreate).not.toHaveBeenCalled();
    });

    it("退出仍可用，但走注入的 quitApp（先确认设置草稿）", async () => {
      const { deps, calls } = createDeps();
      const { handleMenuEvent } = useCommands({
        ...deps,
        isSettingsVisible: () => true,
      });

      await handleMenuEvent("quit");

      expect(calls.quitApp).toHaveBeenCalledTimes(1);
    });

    it("只读命令（关于 / 检查更新）仍然放行", async () => {
      const { deps, calls } = createDeps();
      const { handleMenuEvent } = useCommands({
        ...deps,
        isSettingsVisible: () => true,
      });

      await handleMenuEvent("check-updates");

      expect(calls.checkUpdates).toHaveBeenCalledTimes(1);
    });
  });

  describe("新建文件 / 新建文件夹", () => {
    it("有工作区时先切回文件树视图，让内联命名框可见", async () => {
      const { deps, calls } = createDeps();
      const { handleMenuEvent } = useCommands(deps);

      await handleMenuEvent("new-file");

      expect(calls.selectSidebarView).toHaveBeenCalledWith("files");
      expect(calls.beginRootCreate).toHaveBeenCalledWith("file");
      expect(calls.selectSidebarView.mock.invocationCallOrder[0]).toBeLessThan(
        calls.beginRootCreate.mock.invocationCallOrder[0]
      );
    });

    it("新建文件夹同样先切回文件树视图", async () => {
      const { deps, calls } = createDeps();
      const { handleMenuEvent } = useCommands(deps);

      await handleMenuEvent("new-folder");

      expect(calls.selectSidebarView).toHaveBeenCalledWith("files");
      expect(calls.beginRootCreate).toHaveBeenCalledWith("directory");
    });

    it("无工作区时新建文件直接开空白标签", async () => {
      const { deps, calls } = createDeps();
      const { handleMenuEvent } = useCommands({
        ...deps,
        workspace: { ...deps.workspace, hasWorkspace: false, workspacePath: null },
      });

      await handleMenuEvent("new-file");

      expect(calls.newTab).toHaveBeenCalledTimes(1);
      expect(calls.beginRootCreate).not.toHaveBeenCalled();
    });
  });
});
