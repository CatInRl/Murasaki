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
    dialog: {
      unsavedChanges: vi.fn().mockResolvedValue("cancel"),
      alert: vi.fn(),
    } as never,
    ...overrides,
  };
}

beforeEach(() => {
  mockedSaveDialog.mockReset();
});

describe("useTabClose", () => {
  describe("onCloseTabRequest", () => {
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

  describe("批量关闭", () => {
    function batchDeps(
      tabs: ReturnType<typeof makeTab>[],
      overrides: Partial<TabCloseDeps> = {}
    ): TabCloseDeps {
      return makeDeps({
        tabsStore: {
          tabs,
          activeTabId: tabs[0]?.id ?? null,
          closeTab: vi.fn(),
          doCloseTab: vi.fn().mockResolvedValue(undefined),
          saveTab: vi.fn().mockResolvedValue(undefined),
          saveTabAs: vi.fn().mockResolvedValue(undefined),
        } as never,
        ...overrides,
      });
    }

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

    it("无未保存改动 → 静默关闭，不弹确认框", async () => {
      const deps = batchDeps([makeTab({ id: "t1" }), makeTab({ id: "t2" })]);
      await useTabClose(deps).onCloseAllTabs();
      expect(deps.dialog.unsavedChanges).not.toHaveBeenCalled();
      expect(deps.tabsStore.doCloseTab).toHaveBeenCalledTimes(2);
    });

    it("存在未保存改动 → 只弹一次确认，取消则整批不关闭", async () => {
      const unsavedChanges = vi.fn().mockResolvedValue("cancel");
      const deps = batchDeps(
        [makeTab({ id: "t1", isDirty: true }), makeTab({ id: "t2", isDirty: true })],
        { dialog: { unsavedChanges, alert: vi.fn() } as never }
      );
      await useTabClose(deps).onCloseAllTabs();
      expect(unsavedChanges).toHaveBeenCalledTimes(1);
      expect(deps.tabsStore.doCloseTab).not.toHaveBeenCalled();
    });

    it("选「不保存关闭」→ 全部关闭", async () => {
      const deps = batchDeps(
        [makeTab({ id: "t1", isDirty: true }), makeTab({ id: "t2", isDirty: true })],
        { dialog: { unsavedChanges: vi.fn().mockResolvedValue("discard"), alert: vi.fn() } as never }
      );
      await useTabClose(deps).onCloseAllTabs();
      expect(deps.tabsStore.saveTab).not.toHaveBeenCalled();
      expect(deps.tabsStore.doCloseTab).toHaveBeenCalledWith("t1");
      expect(deps.tabsStore.doCloseTab).toHaveBeenCalledWith("t2");
    });

    it("选「全部保存并关闭」→ 逐个保存后关闭", async () => {
      const deps = batchDeps(
        [
          makeTab({ id: "t1", path: "/test/a.md", isDirty: true }),
          makeTab({ id: "t2", path: "/test/b.md", isDirty: true }),
        ],
        { dialog: { unsavedChanges: vi.fn().mockResolvedValue("save"), alert: vi.fn() } as never }
      );
      await useTabClose(deps).onCloseAllTabs();
      expect(deps.tabsStore.saveTab).toHaveBeenCalledWith("t1");
      expect(deps.tabsStore.saveTab).toHaveBeenCalledWith("t2");
      expect(deps.tabsStore.doCloseTab).toHaveBeenCalledTimes(2);
    });

    it("未命名标签 → 汇总文案含未命名标记与不可恢复提示", async () => {
      const unsavedChanges = vi.fn().mockResolvedValue("cancel");
      const deps = batchDeps(
        [
          makeTab({ id: "t1", path: "/test/a.md", isDirty: true }),
          makeTab({ id: "t2", path: null, isDirty: true }),
        ],
        { dialog: { unsavedChanges, alert: vi.fn() } as never }
      );
      await useTabClose(deps).onCloseAllTabs();
      const options = unsavedChanges.mock.calls[0][0] as { message: string; saveText: string };
      expect(options.message).toContain("a.md");
      expect(options.message).toContain("未命名");
      expect(options.message).toContain("无法恢复");
      expect(options.saveText).toBe("全部保存并关闭");
    });

    it("保存被取消（另存为对话框取消）→ 整批中止，不关闭任何标签", async () => {
      mockedSaveDialog.mockResolvedValue(null);
      const deps = batchDeps(
        [makeTab({ id: "t1", path: null, isDirty: true })],
        { dialog: { unsavedChanges: vi.fn().mockResolvedValue("save"), alert: vi.fn() } as never }
      );
      await useTabClose(deps).onCloseAllTabs();
      expect(mockedSaveDialog).toHaveBeenCalled();
      expect(deps.tabsStore.doCloseTab).not.toHaveBeenCalled();
    });
  });
});
