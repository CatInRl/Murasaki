import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useTabsStore } from "./useTabsStore";
import type { Tab } from "../types";

// 路径去重（#304）：同一文件可能以不同分隔符写法到达，openFile 的「是否已打开」与
// getTabByPath 的查找都必须按归一化路径比较，否则会重复开 tab / 找不到 tab。
//
// 按 `services/fileSystem.ts` 头部说明：测试 mock 该模块，而不是 mock Tauri invoke。
vi.mock("../services/fileSystem", () => ({
  fileSystem: {
    readText: vi.fn(async (path: string) => `content of ${path}`),
    getMtime: vi.fn(async () => 1_700_000_000_000),
    draftExists: vi.fn(async () => false),
    saveDraft: vi.fn(async () => undefined),
    deleteDraft: vi.fn(async () => undefined),
  },
}));

// useTabsStore 依赖持久化 store，这里只关心标签本身，故整个替换掉
// saveTabs 用 hoisted 单例，便于断言落盘次数（#429）
const { saveTabsSpy } = vi.hoisted(() => ({
  saveTabsSpy: vi.fn(async (_tabs: Array<{ content: string }>, _activeIndex: number) => {}),
}));
vi.mock("./usePersistenceStore", () => ({
  usePersistenceStore: () => ({
    loadTabs: vi.fn(async () => ({ tabs: [], activeIndex: 0 })),
    saveTabs: saveTabsSpy,
  }),
}));

// 草稿兜底失败的反馈断言（#378）：spy 单例供各用例断言
const { warningSpy } = vi.hoisted(() => ({ warningSpy: vi.fn() }));
vi.mock("./useToastStore", () => ({
  useToastStore: () => ({ warning: warningSpy }),
}));

beforeEach(() => {
  setActivePinia(createPinia());
  warningSpy.mockClear();
  saveTabsSpy.mockClear();
});

describe("useTabsStore", () => {
  describe("同一文件的路径写法归一（#304）", () => {
    it("反斜杠与正斜杠写法只开一个 tab，且返回同一个 tab", async () => {
      const store = useTabsStore();
      const first = await store.openFile("C:\\docs\\a.md");
      const second = await store.openFile("C:/docs/a.md");

      expect(store.tabs.length).toBe(1);
      expect(second.id).toBe(first.id);
    });

    it("混合分隔符写法同样只开一个 tab", async () => {
      const store = useTabsStore();
      await store.openFile("C:\\docs/a.md");
      await store.openFile("C:/docs\\a.md");

      expect(store.tabs.length).toBe(1);
    });

    it("大小写不同视为同一文件（与 isPathUnder 同口径）", async () => {
      const store = useTabsStore();
      await store.openFile("C:/docs/a.md");
      await store.openFile("c:/DOCS/A.MD");

      expect(store.tabs.length).toBe(1);
    });

    it("getTabByPath 两种写法都能命中已打开的 tab", async () => {
      const store = useTabsStore();
      await store.openFile("C:\\docs\\a.md");

      expect(store.getTabByPath("C:/docs/a.md")?.path).toBe("C:\\docs\\a.md");
      expect(store.getTabByPath("c:/DOCS/a.md")?.path).toBe("C:\\docs\\a.md");
    });

    it("不同文件仍各自开 tab", async () => {
      const store = useTabsStore();
      await store.openFile("C:\\docs\\a.md");
      await store.openFile("C:\\docs\\b.md");
      await store.openFile("C:\\docs\\a.md2");

      expect(store.tabs.length).toBe(3);
    });

    it("getTabByPath 对未打开的文件返回 null；未命名 tab 不会被路径命中", async () => {
      const store = useTabsStore();
      store.newTab("未命名");
      await store.openFile("C:/docs/a.md");

      expect(store.getTabByPath("C:/docs/missing.md")).toBeNull();
      expect(store.getTabByPath("C:/docs/a.md")?.path).toBe("C:/docs/a.md");
    });

    it("已打开的 tab 被激活（openFile 默认 activate）", async () => {
      const store = useTabsStore();
      const first = await store.openFile("C:\\docs\\a.md");
      await store.openFile("C:/docs/b.md");
      await store.openFile("C:/docs/a.md");

      expect(store.activeTabId).toBe(first.id);
    });
  });

  // #385：store 层不得存本地化字符串——「未命名」文案由渲染层按当前语言注入，
  // 否则切换语言后标签标题仍是旧语言的硬编码。
  describe("getTabTitle（#385 标题去本地化）", () => {
    it("有 path 时返回 basename，与注入文案无关", () => {
      const store = useTabsStore();
      const tab = { id: "t1", path: "C:/docs/note.md" } as unknown as Tab;
      expect(store.getTabTitle(tab, "Untitled")).toBe("note.md");
    });

    it("无 path 时返回调用方注入的文案，不再硬编码「未命名」", () => {
      const store = useTabsStore();
      const tab = { id: "t2", path: null } as unknown as Tab;
      expect(store.getTabTitle(tab, "Untitled")).toBe("Untitled");
    });

    it("注入不同文案返回不同文案（文案确实来自参数）", () => {
      const store = useTabsStore();
      const tab = { id: "t3", path: null } as unknown as Tab;
      expect(store.getTabTitle(tab, "無題")).toBe("無題");
    });
  });

  describe("外部修改：load-disk 前写草稿兜底（#378）", () => {
    it("load-disk 会丢弃本地未保存内容，覆盖前先以磁盘当前 mtime 写草稿", async () => {
      const { fileSystem } = await import("../services/fileSystem");
      const saveDraftSpy = fileSystem.saveDraft as unknown as ReturnType<typeof vi.fn>;
      const store = useTabsStore();
      const tab = await store.openFile("C:\\docs\\a.md");
      store.updateContent(tab.id, "本地未保存的修改");

      // 外部修改后磁盘 mtime 变化
      (fileSystem.getMtime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        1_700_000_999_000
      );
      await store.applyExternalResolution("C:\\docs\\a.md", "load-disk", "磁盘新内容");

      // 草稿内容必须是覆盖前的本地内容、knownMtime 必须是磁盘当前 mtime
      //（否则下次打开会被 ADR-0001 判为过期草稿而丢弃，兜底失效）
      expect(saveDraftSpy).toHaveBeenCalledWith(
        "C:\\docs\\a.md",
        "本地未保存的修改",
        1_700_000_999_000
      );
      expect(tab.content).toBe("磁盘新内容");
      expect(tab.isDirty).toBe(false);
    });

    it("tab 无未保存修改时 load-disk 不写草稿", async () => {
      const { fileSystem } = await import("../services/fileSystem");
      const saveDraftSpy = fileSystem.saveDraft as unknown as ReturnType<typeof vi.fn>;
      const store = useTabsStore();
      await store.openFile("C:\\docs\\a.md");
      (fileSystem.getMtime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        1_700_000_999_000
      );

      await store.applyExternalResolution("C:\\docs\\a.md", "load-disk", "磁盘新内容");

      expect(saveDraftSpy).not.toHaveBeenCalled();
    });

    it("keep-local 不写草稿（本地内容仍在 tab 中）", async () => {
      const { fileSystem } = await import("../services/fileSystem");
      const saveDraftSpy = fileSystem.saveDraft as unknown as ReturnType<typeof vi.fn>;
      const store = useTabsStore();
      const tab = await store.openFile("C:\\docs\\a.md");
      store.updateContent(tab.id, "本地未保存的修改");
      (fileSystem.getMtime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        1_700_000_999_000
      );

      await store.applyExternalResolution("C:\\docs\\a.md", "keep-local");

      expect(saveDraftSpy).not.toHaveBeenCalled();
      expect(tab.content).toBe("本地未保存的修改");
      expect(tab.isDirty).toBe(true);
    });
  });

  describe("草稿兜底写失败时的用户反馈（#378 评审补充）", () => {
    it("doCloseTab 写草稿失败：仍完成关闭，并 toast 警告不静默", async () => {
      const { fileSystem } = await import("../services/fileSystem");
      (fileSystem.saveDraft as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("disk full")
      );
      const store = useTabsStore();
      const tab = await store.openFile("C:\\docs\\a.md");
      store.updateContent(tab.id, "未保存的修改");

      await expect(store.doCloseTab(tab.id)).resolves.toBeTruthy();
      expect(store.tabs).toHaveLength(0);
      expect(warningSpy).toHaveBeenCalledTimes(1);
    });

    it("load-disk 前写草稿失败：继续加载磁盘内容，并 toast 警告不静默", async () => {
      const { fileSystem } = await import("../services/fileSystem");
      (fileSystem.saveDraft as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("disk full")
      );
      const store = useTabsStore();
      const tab = await store.openFile("C:\\docs\\a.md");
      store.updateContent(tab.id, "本地未保存的修改");
      (fileSystem.getMtime as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        1_700_000_999_000
      );

      await store.applyExternalResolution("C:\\docs\\a.md", "load-disk", "磁盘新内容");

      expect(tab.content).toBe("磁盘新内容");
      expect(tab.isDirty).toBe(false);
      expect(warningSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("应用内移动后同步标签路径（#427）", () => {
    it("文件重命名同步单个标签", async () => {
      const store = useTabsStore();
      const tab = await store.openFile("C:\\docs\\a.md");

      await store.syncPathsAfterMove("C:\\docs\\a.md", "C:\\docs\\b.md");
      expect(tab.path).toBe("C:/docs/b.md");
    });

    it("脏标签的草稿迁到新路径键下", async () => {
      const { fileSystem } = await import("../services/fileSystem");
      const saveDraft = fileSystem.saveDraft as unknown as ReturnType<typeof vi.fn>;
      const deleteDraft = fileSystem.deleteDraft as unknown as ReturnType<typeof vi.fn>;
      saveDraft.mockClear();
      deleteDraft.mockClear();
      const store = useTabsStore();
      const tab = await store.openFile("C:\\docs\\a.md");
      store.updateContent(tab.id, "未保存的新内容");

      await store.syncPathsAfterMove("C:\\docs\\a.md", "C:\\docs\\b.md");

      // 新键用归一化后的路径；旧键仍用原始写法（草稿文件名是原串的 sha1）
      expect(saveDraft).toHaveBeenCalledWith("C:/docs/b.md", "未保存的新内容", tab.lastMtime);
      expect(deleteDraft).toHaveBeenCalledWith("C:\\docs\\a.md");
    });

    it("目录移动同步其下所有已打开标签", async () => {
      const store = useTabsStore();
      const first = await store.openFile("C:\\docs\\a.md");
      const second = await store.openFile("C:\\docs\\sub\\b.md");

      await store.syncPathsAfterMove("C:\\docs", "C:\\archive");

      expect(first.path).toBe("C:/archive/a.md");
      expect(second.path).toBe("C:/archive/sub/b.md");
    });

    it("不改动不在移动范围内的标签", async () => {
      const store = useTabsStore();
      const other = await store.openFile("C:\\other\\c.md");

      await store.syncPathsAfterMove("C:\\docs", "C:\\archive");

      expect(other.path).toBe("C:\\other\\c.md");
    });
  });

  describe("重新加载前写草稿兜底（#424）", () => {
    it("有未保存改动时先写草稿，再覆盖为磁盘内容", async () => {
      const { fileSystem } = await import("../services/fileSystem");
      const saveDraft = fileSystem.saveDraft as unknown as ReturnType<typeof vi.fn>;
      const getMtime = fileSystem.getMtime as unknown as ReturnType<typeof vi.fn>;
      saveDraft.mockClear();
      const store = useTabsStore();
      const tab = await store.openFile("C:\\docs\\a.md");
      store.updateContent(tab.id, "本地未保存");
      const baselineBeforeReload = tab.lastMtime;
      const diskMtimeAfterChange = 1_700_000_999_000;
      getMtime.mockResolvedValueOnce(diskMtimeAfterChange);

      await store.reloadFromDisk("C:\\docs\\a.md");

      // 刻意断言「重载前的基线」：草稿代表基于旧版本的本地内容，
      // 磁盘外部变更时下次打开应走冲突裁决，而不是让丢弃的修改复活。
      expect(saveDraft).toHaveBeenCalledWith("C:\\docs\\a.md", "本地未保存", baselineBeforeReload);
      expect(tab.content).toBe("content of C:\\docs\\a.md");
      expect(tab.lastMtime).toBe(diskMtimeAfterChange);
      expect(tab.isDirty).toBe(false);
    });

    it("没有未保存改动时不写草稿", async () => {
      const { fileSystem } = await import("../services/fileSystem");
      const saveDraft = fileSystem.saveDraft as unknown as ReturnType<typeof vi.fn>;
      saveDraft.mockClear();
      const store = useTabsStore();
      await store.openFile("C:\\docs\\a.md");

      await store.reloadFromDisk("C:\\docs\\a.md");

      expect(saveDraft).not.toHaveBeenCalled();
    });
  });

  describe("关闭时「不保存」的草稿语义（#426）", () => {
    it("keepDraft=false：不写草稿并删除已有草稿", async () => {
      const { fileSystem } = await import("../services/fileSystem");
      const saveDraft = fileSystem.saveDraft as unknown as ReturnType<typeof vi.fn>;
      const deleteDraft = fileSystem.deleteDraft as unknown as ReturnType<typeof vi.fn>;
      saveDraft.mockClear();
      deleteDraft.mockClear();
      const store = useTabsStore();
      const tab = await store.openFile("C:\\docs\\a.md");
      store.updateContent(tab.id, "用户明确不要的修改");

      await store.doCloseTab(tab.id, { keepDraft: false });

      expect(saveDraft).not.toHaveBeenCalled();
      expect(deleteDraft).toHaveBeenCalledWith("C:\\docs\\a.md");
      expect(store.tabs).toHaveLength(0);
    });

    it("默认仍保留草稿（关闭窗口 / 崩溃兜底）", async () => {
      const { fileSystem } = await import("../services/fileSystem");
      const saveDraft = fileSystem.saveDraft as unknown as ReturnType<typeof vi.fn>;
      saveDraft.mockClear();
      const store = useTabsStore();
      const tab = await store.openFile("C:\\docs\\a.md");
      store.updateContent(tab.id, "需要兜底");

      await store.doCloseTab(tab.id);

      expect(saveDraft).toHaveBeenCalledWith("C:\\docs\\a.md", "需要兜底", tab.lastMtime);
    });
  });

  describe("tabs.json 合并写入（#429）", () => {
    it("高频变更只落盘一次，写入的是最新内容", async () => {
      vi.useFakeTimers();
      try {
        const store = useTabsStore();
        const tab = store.newTab("a");
        for (let i = 1; i <= 20; i++) {
          store.updateContent(tab.id, "a".repeat(i));
          store.schedulePersist();
        }
        expect(saveTabsSpy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1500);

        expect(saveTabsSpy).toHaveBeenCalledTimes(1);
        const saved = saveTabsSpy.mock.calls[0][0];
        expect(saved[0].content).toBe("a".repeat(20));
      } finally {
        vi.useRealTimers();
      }
    });

    it("合并窗口结束后再次变更会重新排一次写（持续输入不会被无限延后）", async () => {
      vi.useFakeTimers();
      try {
        const store = useTabsStore();
        const tab = store.newTab("a");
        store.schedulePersist();
        await vi.advanceTimersByTimeAsync(1500);
        expect(saveTabsSpy).toHaveBeenCalledTimes(1);

        store.updateContent(tab.id, "b");
        store.schedulePersist();
        await vi.advanceTimersByTimeAsync(1500);
        expect(saveTabsSpy).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("显式 persist（退出路径）立即落盘，并取消已排队的合并写", async () => {
      vi.useFakeTimers();
      try {
        const store = useTabsStore();
        store.newTab("a");
        store.schedulePersist();

        await store.persist();
        expect(saveTabsSpy).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(2000);
        expect(saveTabsSpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("clearAll 取消已排队的合并写，不会把空数组写进 tabs.json", async () => {
      vi.useFakeTimers();
      try {
        const store = useTabsStore();
        store.newTab("a");
        store.schedulePersist();

        store.clearAll();
        await vi.advanceTimersByTimeAsync(2000);

        expect(saveTabsSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("落盘串行执行：前一次没写完时，后一次排队等待", async () => {
      const store = useTabsStore();
      store.newTab("a");

      let release: (() => void) | undefined;
      saveTabsSpy.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          })
      );

      const first = store.persist();
      const second = store.persist();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(saveTabsSpy).toHaveBeenCalledTimes(1);

      release?.();
      await Promise.all([first, second]);
      expect(saveTabsSpy).toHaveBeenCalledTimes(2);
    });
  });
});
