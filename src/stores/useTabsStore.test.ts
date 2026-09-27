import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useTabsStore } from "./useTabsStore";

// 路径去重（#304）：同一文件可能以不同分隔符写法到达，openFile 的「是否已打开」与
// getTabByPath 的查找都必须按归一化路径比较，否则会重复开 tab / 找不到 tab。
//
// 按 `services/fileSystem.ts` 头部说明：测试 mock 该模块，而不是 mock Tauri invoke。
vi.mock("../services/fileSystem", () => ({
  fileSystem: {
    readText: vi.fn(async (path: string) => `content of ${path}`),
    getMtime: vi.fn(async () => 1_700_000_000_000),
    draftExists: vi.fn(async () => false),
  },
}));

// useTabsStore 依赖持久化 store，这里只关心标签本身，故整个替换掉
vi.mock("./usePersistenceStore", () => ({
  usePersistenceStore: () => ({
    loadTabs: vi.fn(async () => ({ tabs: [], activeIndex: 0 })),
    saveTabs: vi.fn(async () => {}),
  }),
}));

beforeEach(() => {
  setActivePinia(createPinia());
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
});
