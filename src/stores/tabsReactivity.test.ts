/**
 * Tab 派生字段的响应式回归测试（#449 / ADR-0022）
 *
 * 背景：Tab.content / isDirty / lastMtime 改成「每次读取都回会话取快照」的 getter 后，
 * 会话是普通对象、不经 Vue 响应式包裹，getter 本身**不建立依赖**。
 * 若不加响应式信号，标签栏的 dirty 圆点、状态栏的「未保存」、关闭前的未保存确认
 * 都会停在旧值（内容变了 UI 不刷新）。
 *
 * 这里的断言是文件级护栏：store 必须让 `tabs` / `activeTab` 上的派生字段可被追踪。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { computed, watchEffect } from "vue";
import { useTabsStore } from "./useTabsStore";
import type { DocumentStore, DraftSnapshot } from "../editor/session/types";

vi.mock("../services/fileSystem", () => ({
  fileSystem: {
    readText: vi.fn(async (path: string) => `content of ${path}`),
    writeText: vi.fn(async () => undefined),
    getMtime: vi.fn(async () => 1_700_000_000_000),
    draftExists: vi.fn(async () => false),
    readDraft: vi.fn(),
    saveDraft: vi.fn(async () => undefined),
    deleteDraft: vi.fn(async () => undefined),
  },
}));

vi.mock("../editor/session/documentStore", async () => {
  const { fileSystem } = await import("../services/fileSystem");
  const fs = fileSystem as never as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const store: DocumentStore = {
    readText: (p) => fs.readText(p) as Promise<string>,
    writeText: (p, c) => fs.writeText(p, c) as Promise<void>,
    mtime: (p) => fs.getMtime(p) as Promise<number>,
    draftExists: (p) => fs.draftExists(p) as Promise<boolean>,
    async readDraft(p): Promise<DraftSnapshot> {
      const [content, meta] = (await fs.readDraft(p)) as [
        string,
        { knownMtime: number; savedAt: number },
      ];
      return { content, knownMtime: meta.knownMtime, savedAt: meta.savedAt };
    },
    writeDraft: (p, c, m) => fs.saveDraft(p, c, m) as Promise<void>,
    deleteDraft: (p) => fs.deleteDraft(p) as Promise<void>,
  };
  return { createDocumentStore: () => store };
});

vi.mock("./usePersistenceStore", () => ({
  usePersistenceStore: () => ({
    loadTabs: vi.fn(async () => ({ tabs: [], activeIndex: 0 })),
    saveTabs: vi.fn(async () => undefined),
  }),
}));
vi.mock("./useToastStore", () => ({ useToastStore: () => ({ warning: vi.fn() }) }));

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("响应式：内容变化能否驱动 UI 重算", () => {
  it("activeTab.isDirty 的 computed 会随内容变化更新", async () => {
    const store = useTabsStore();
    const tab = await store.openFile("C:\\docs\\a.md");

    const seen: boolean[] = [];
    const stop = watchEffect(() => {
      seen.push(store.activeTab?.isDirty ?? false);
    });

    store.updateContent(tab.id, "改了");
    await Promise.resolve();

    stop();
    expect(seen).toEqual([false, true]);
  });

  it("tabs 数组里每个 tab 的 isDirty 同样可被追踪", async () => {
    const store = useTabsStore();
    const tab = await store.openFile("C:\\docs\\a.md");

    const dirtyList = computed(() => store.tabs.map((t) => t.isDirty));
    const seen: boolean[][] = [];
    const stop = watchEffect(() => {
      seen.push([...dirtyList.value]);
    });

    store.updateContent(tab.id, "改了");
    await Promise.resolve();

    stop();
    expect(seen).toEqual([[false], [true]]);
  });

  it("撤销回磁盘内容后，UI 侧的未保存标记跟着消失", async () => {
    const store = useTabsStore();
    const tab = await store.openFile("C:\\docs\\a.md");
    const diskContent = tab.content;

    const seen: boolean[] = [];
    const stop = watchEffect(() => {
      seen.push(store.activeTab?.isDirty ?? false);
    });

    store.updateContent(tab.id, "改了");
    await Promise.resolve();
    store.updateContent(tab.id, diskContent);
    await Promise.resolve();

    stop();
    expect(seen).toEqual([false, true, false]);
  });

  it("外部解析（加载磁盘版本）同样驱动 UI 更新", async () => {
    const store = useTabsStore();
    const tab = await store.openFile("C:\\docs\\a.md");
    store.updateContent(tab.id, "本地改动");

    const seen: string[] = [];
    const stop = watchEffect(() => {
      seen.push(store.activeTab?.content ?? "");
    });

    await store.applyExternalResolution("C:\\docs\\a.md", "load-disk", "磁盘新内容");
    await Promise.resolve();

    stop();
    expect(seen).toContain("磁盘新内容");
  });
});
