import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import type { PersistedTab } from "../types";

// ===== 内存版 tauri-plugin-store =====
// 每个文件名一份 Map，模拟 LazyStore 的 get/set/save 语义
const files = new Map<string, Map<string, unknown>>();
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    private readonly data: Map<string, unknown>;
    constructor(name: string) {
      if (!files.has(name)) files.set(name, new Map());
      this.data = files.get(name)!;
    }
    async get<T>(key: string): Promise<T | undefined> {
      return this.data.get(key) as T | undefined;
    }
    async set(key: string, value: unknown): Promise<void> {
      this.data.set(key, value);
    }
    async save(): Promise<void> {
      // 内存实现无需落盘
    }
  },
}));

// ===== 多窗口分片：由用例控制当前是否主窗口 =====
let mainWindow = true;
vi.mock("../utils/windowContext", () => ({
  isMainWindow: () => mainWindow,
  tabsStoreKey: () => (mainWindow ? "state" : "state:win-1"),
}));

import { usePersistenceStore } from "./usePersistenceStore";
import { DEFAULT_SETTINGS } from "../types";

const TAB: PersistedTab = {
  path: "/ws/a.md",
  content: "# A",
  lastMtime: 123,
  cursor: { line: 0, ch: 0 },
  scroll: { x: 0, y: 0 },
};

beforeEach(() => {
  files.clear();
  mainWindow = true;
  setActivePinia(createPinia());
});

describe("usePersistenceStore", () => {
  describe("settings", () => {
    it("首次加载：无保存值时保留默认值并把语言标记为「从未写入」", async () => {
      const store = usePersistenceStore();
      await store.loadSettings();
      expect(store.settings).toEqual(DEFAULT_SETTINGS);
      expect(store.languageEmpty).toBe(true);
    });

    it("加载时与默认值合并，旧配置缺的新字段取默认值", async () => {
      files.set("settings.json", new Map([["state", { language: "en", editorFontSize: 18 }]]));
      const store = usePersistenceStore();
      await store.loadSettings();
      expect(store.settings.language).toBe("en");
      expect(store.settings.editorFontSize).toBe(18);
      // 其它字段回退到默认值
      expect(store.settings.showLineNumbers).toBe(DEFAULT_SETTINGS.showLineNumbers);
      expect(store.languageEmpty).toBe(false);
    });

    it("updateSettings 局部合并并写回同 key", async () => {
      const store = usePersistenceStore();
      await store.updateSettings({ editorFontSize: 20 });
      expect(store.settings.editorFontSize).toBe(20);
      const saved = files.get("settings.json")!.get("state") as { editorFontSize: number };
      expect(saved.editorFontSize).toBe(20);
    });
  });

  describe("recent", () => {
    it("addRecent 按归一化路径去重并置顶", async () => {
      const store = usePersistenceStore();
      await store.addRecent("C:/ws/a.md", "file");
      await store.addRecent("C:/ws/b.md", "file");
      await store.addRecent("C:/ws/a.md", "file");
      expect(store.recentEntries.map((e) => e.path)).toEqual(["C:/ws/a.md", "C:/ws/b.md"]);
    });

    it("addRecent 最多保留 20 条", async () => {
      const store = usePersistenceStore();
      for (let i = 0; i < 25; i++) {
        await store.addRecent(`C:/ws/${i}.md`, "file");
      }
      expect(store.recentEntries).toHaveLength(20);
      expect(store.recentEntries[0].path).toBe("C:/ws/24.md");
    });

    it("getRecentFolders / getRecentFiles 按类型过滤并限制条数", async () => {
      const store = usePersistenceStore();
      for (let i = 0; i < 7; i++) {
        await store.addRecent(`C:/ws/dir${i}`, "folder");
        await store.addRecent(`C:/ws/f${i}.md`, "file");
      }
      expect(store.getRecentFolders()).toHaveLength(5);
      expect(store.getRecentFiles()).toHaveLength(5);
      expect(store.getRecentFolders().every((e) => e.type === "folder")).toBe(true);
    });
  });

  describe("tabs", () => {
    it("主窗口保存后能读回同一份标签状态", async () => {
      const store = usePersistenceStore();
      await store.saveTabs([TAB], 0);
      const loaded = await store.loadTabs();
      expect(loaded.tabs).toEqual([TAB]);
      expect(loaded.activeIndex).toBe(0);
    });

    it("非主窗口不参与启动恢复：loadTabs 直接返回空", async () => {
      mainWindow = false;
      const store = usePersistenceStore();
      // 即使磁盘里有数据也不恢复
      files.set("tabs.json", new Map([["state:win-1", { tabs: [TAB], activeIndex: 0 }]]));
      expect(await store.loadTabs()).toEqual({ tabs: [], activeIndex: 0 });
    });

    it("clearTabs 落盘空状态", async () => {
      const store = usePersistenceStore();
      await store.saveTabs([TAB], 0);
      await store.clearTabs();
      const saved = files.get("tabs.json")!.get("state") as { tabs: unknown[] };
      expect(saved.tabs).toEqual([]);
    });
  });
});
