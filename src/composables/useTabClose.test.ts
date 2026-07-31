import { describe, it, expect, beforeEach, vi } from "vitest";
import { useTabClose, type TabCloseDeps } from "./useTabClose";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));

import { save as saveDialog } from "@tauri-apps/plugin-dialog";

const mockedSaveDialog = saveDialog as unknown as ReturnType<typeof vi.fn>;

function makeTab(overrides: Partial<{
  id: string;
  path: string | null;
  content: string;
  isDirty: boolean;
}> = {}) {
  return {
    id: "tab1",
    path: "/test/file.md",
    content: "hello",
    isDirty: false,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<TabCloseDeps> = {}): TabCloseDeps {
  return {
    tabsStore: {
      tabs: [makeTab()],
      activeTabId: "tab1",
      closeTab: vi.fn().mockResolvedValue(undefined),
      doCloseTab: vi.fn().mockResolvedValue(undefined),
      saveTab: vi.fn().mockResolvedValue(undefined),
      saveTabAs: vi.fn().mockResolvedValue(undefined),
    } as never,
    agentStore: {
      isThinking: false,
      cancel: vi.fn(),
    } as never,
    dialog: {
      unsavedChanges: vi.fn().mockResolvedValue("cancel"),
      confirm: vi.fn().mockResolvedValue(false),
      alert: vi.fn(),
    } as never,
    ...overrides,
  };
}

beforeEach(() => {
  mockedSaveDialog.mockReset();
});

describe("useTabClose", () => {
  describe("onCloseTabRequest - 无 agent", () => {
    it("无未保存修改 → 直接 closeTab", async () => {
      const deps = makeDeps({
        tabsStore: {
          tabs: [makeTab({ isDirty: false })],
          activeTabId: "tab1",
          closeTab: vi.fn().mockResolvedValue(undefined),
          doCloseTab: vi.fn(),
          saveTab: vi.fn(),
          saveTabAs: vi.fn(),
        } as never,
      });
      const { onCloseTabRequest } = useTabClose(deps);
      await onCloseTabRequest("tab1");
      expect(deps.tabsStore.closeTab).toHaveBeenCalledWith("tab1");
      expect(deps.dialog.unsavedChanges).not.toHaveBeenCalled();
    });

    it("有未保存修改 + 用户选 cancel → 不关闭", async () => {
      const deps = makeDeps({
        tabsStore: {
          tabs: [makeTab({ isDirty: true })],
          activeTabId: "tab1",
          closeTab: vi.fn(),
          doCloseTab: vi.fn(),
          saveTab: vi.fn(),
          saveTabAs: vi.fn(),
        } as never,
        dialog: {
          unsavedChanges: vi.fn().mockResolvedValue("cancel"),
          alert: vi.fn(),
        } as never,
      });
      const { onCloseTabRequest } = useTabClose(deps);
      await onCloseTabRequest("tab1");
      expect(deps.dialog.unsavedChanges).toHaveBeenCalled();
      expect(deps.tabsStore.closeTab).not.toHaveBeenCalled();
      expect(deps.tabsStore.doCloseTab).not.toHaveBeenCalled();
    });

    it("有未保存修改 + 用户选 save（有路径）→ saveTab + doCloseTab", async () => {
      const deps = makeDeps({
        tabsStore: {
          tabs: [makeTab({ isDirty: true, path: "/test/file.md" })],
          activeTabId: "tab1",
          closeTab: vi.fn(),
          doCloseTab: vi.fn().mockResolvedValue(undefined),
          saveTab: vi.fn().mockResolvedValue(undefined),
          saveTabAs: vi.fn(),
        } as never,
        dialog: {
          unsavedChanges: vi.fn().mockResolvedValue("save"),
          alert: vi.fn(),
        } as never,
      });
      const { onCloseTabRequest } = useTabClose(deps);
      await onCloseTabRequest("tab1");
      expect(deps.tabsStore.saveTab).toHaveBeenCalledWith("tab1");
      expect(deps.tabsStore.doCloseTab).toHaveBeenCalledWith("tab1");
    });

    it("有未保存修改 + 用户选 discard → doCloseTab（不保存）", async () => {
      const deps = makeDeps({
        tabsStore: {
          tabs: [makeTab({ isDirty: true })],
          activeTabId: "tab1",
          closeTab: vi.fn(),
          doCloseTab: vi.fn().mockResolvedValue(undefined),
          saveTab: vi.fn(),
          saveTabAs: vi.fn(),
        } as never,
        dialog: {
          unsavedChanges: vi.fn().mockResolvedValue("discard"),
          alert: vi.fn(),
        } as never,
      });
      const { onCloseTabRequest } = useTabClose(deps);
      await onCloseTabRequest("tab1");
      expect(deps.tabsStore.saveTab).not.toHaveBeenCalled();
      expect(deps.tabsStore.doCloseTab).toHaveBeenCalledWith("tab1");
    });

    it("有未保存修改 + 用户选 save（无路径）→ saveDialog + saveTabAs", async () => {
      mockedSaveDialog.mockResolvedValue("/new/path.md");
      const deps = makeDeps({
        tabsStore: {
          tabs: [makeTab({ isDirty: true, path: null })],
          activeTabId: "tab1",
          closeTab: vi.fn(),
          doCloseTab: vi.fn().mockResolvedValue(undefined),
          saveTab: vi.fn(),
          saveTabAs: vi.fn().mockResolvedValue(undefined),
        } as never,
        dialog: {
          unsavedChanges: vi.fn().mockResolvedValue("save"),
          alert: vi.fn(),
        } as never,
      });
      const { onCloseTabRequest } = useTabClose(deps);
      await onCloseTabRequest("tab1");
      expect(mockedSaveDialog).toHaveBeenCalled();
      expect(deps.tabsStore.saveTabAs).toHaveBeenCalledWith("tab1", "/new/path.md");
      expect(deps.tabsStore.doCloseTab).toHaveBeenCalledWith("tab1");
    });
  });

  describe("onCloseTabRequest - agent 运行中", () => {
    it("agent 运行 + 有未保存 → unsavedChanges + cancel 不中断 agent", async () => {
      const cancel = vi.fn();
      const deps = makeDeps({
        tabsStore: {
          tabs: [makeTab({ isDirty: true })],
          activeTabId: "tab1",
          closeTab: vi.fn(),
          doCloseTab: vi.fn(),
          saveTab: vi.fn(),
          saveTabAs: vi.fn(),
        } as never,
        agentStore: {
          isThinking: true,
          cancel,
        } as never,
        dialog: {
          unsavedChanges: vi.fn().mockResolvedValue("cancel"),
          confirm: vi.fn(),
          alert: vi.fn(),
        } as never,
      });
      const { onCloseTabRequest } = useTabClose(deps);
      await onCloseTabRequest("tab1");
      expect(deps.dialog.unsavedChanges).toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(deps.tabsStore.doCloseTab).not.toHaveBeenCalled();
    });

    it("agent 运行 + 有未保存 → discard（不保存）→ cancel agent + doCloseTab", async () => {
      const cancel = vi.fn();
      const deps = makeDeps({
        tabsStore: {
          tabs: [makeTab({ isDirty: true })],
          activeTabId: "tab1",
          closeTab: vi.fn(),
          doCloseTab: vi.fn().mockResolvedValue(undefined),
          saveTab: vi.fn(),
          saveTabAs: vi.fn(),
        } as never,
        agentStore: {
          isThinking: true,
          cancel,
        } as never,
        dialog: {
          unsavedChanges: vi.fn().mockResolvedValue("discard"),
          confirm: vi.fn(),
          alert: vi.fn(),
        } as never,
      });
      const { onCloseTabRequest } = useTabClose(deps);
      await onCloseTabRequest("tab1");
      expect(cancel).toHaveBeenCalled();
      expect(deps.tabsStore.doCloseTab).toHaveBeenCalledWith("tab1");
    });

    it("agent 运行 + 无未保存 → confirm + 强制关闭 → cancel agent + doCloseTab", async () => {
      const cancel = vi.fn();
      const deps = makeDeps({
        tabsStore: {
          tabs: [makeTab({ isDirty: false })],
          activeTabId: "tab1",
          closeTab: vi.fn(),
          doCloseTab: vi.fn().mockResolvedValue(undefined),
          saveTab: vi.fn(),
          saveTabAs: vi.fn(),
        } as never,
        agentStore: {
          isThinking: true,
          cancel,
        } as never,
        dialog: {
          unsavedChanges: vi.fn(),
          confirm: vi.fn().mockResolvedValue(true),
          alert: vi.fn(),
        } as never,
      });
      const { onCloseTabRequest } = useTabClose(deps);
      await onCloseTabRequest("tab1");
      expect(deps.dialog.confirm).toHaveBeenCalled();
      expect(cancel).toHaveBeenCalled();
      expect(deps.tabsStore.doCloseTab).toHaveBeenCalledWith("tab1");
    });
  });

  describe("批量关闭", () => {
    it("onCloseOthers 关闭除指定外所有 tab", async () => {
      const doCloseTab = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({
        tabsStore: {
          tabs: [
            makeTab({ id: "t1" }),
            makeTab({ id: "t2" }),
            makeTab({ id: "t3" }),
          ],
          activeTabId: "t2",
          closeTab: vi.fn(),
          doCloseTab,
          saveTab: vi.fn(),
          saveTabAs: vi.fn(),
        } as never,
      });
      const { onCloseOthers } = useTabClose(deps);
      await onCloseOthers("t2");
      expect(doCloseTab).toHaveBeenCalledWith("t1");
      expect(doCloseTab).toHaveBeenCalledWith("t3");
      expect(doCloseTab).not.toHaveBeenCalledWith("t2");
    });

    it("onCloseAllTabs 关闭所有 tab", async () => {
      const doCloseTab = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({
        tabsStore: {
          tabs: [makeTab({ id: "t1" }), makeTab({ id: "t2" })],
          activeTabId: "t1",
          closeTab: vi.fn(),
          doCloseTab,
          saveTab: vi.fn(),
          saveTabAs: vi.fn(),
        } as never,
      });
      const { onCloseAllTabs } = useTabClose(deps);
      await onCloseAllTabs();
      expect(doCloseTab).toHaveBeenCalledWith("t1");
      expect(doCloseTab).toHaveBeenCalledWith("t2");
    });
  });
});
