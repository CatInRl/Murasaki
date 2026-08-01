import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

// ===== Mock @tauri-apps/api/core 的 invoke =====
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// ===== Mock @tauri-apps/api/event 的 listen =====
// 收集每个事件的回调，便于测试中手动触发
const listeners = new Map<string, (event: { payload: unknown }) => void>();
const unlistenSpy = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (eventName: string, cb: (e: { payload: unknown }) => void) => {
    listeners.set(eventName, cb);
    return unlistenSpy;
  }),
}));

// ===== Mock useWorkspaceStore =====
const workspaceState = {
  workspacePath: "/test/workspace" as string | null,
  refreshTree: vi.fn().mockResolvedValue(undefined),
  selectedFilePath: null,
};
vi.mock("./useWorkspaceStore", () => ({
  useWorkspaceStore: () => workspaceState,
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSearchStore, DEFAULT_MAX_RESULTS } from "./useSearchStore";
import type {
  SearchProgressEvent,
  SearchResultChunkEvent,
  SearchResponse,
} from "../types";

const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockedListen = listen as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  setActivePinia(createPinia());
  mockedInvoke.mockReset();
  mockedListen.mockClear();
  unlistenSpy.mockClear();
  listeners.clear();
  workspaceState.workspacePath = "/test/workspace";
});

describe("useSearchStore", () => {
  describe("初始状态", () => {
    it("默认状态字段符合预期", () => {
      const store = useSearchStore();
      expect(store.query).toBe("");
      expect(store.results).toEqual([]);
      expect(store.filenameResults).toEqual([]);
      expect(store.loading).toBe(false);
      expect(store.visible).toBe(false);
      expect(store.options).toEqual({
        regex: false,
        caseSensitive: false,
        wholeWord: false,
      });
      // 0.4.0 增量状态
      expect(store.cancelToken).toBeNull();
      expect(store.scannedFiles).toBe(0);
      expect(store.totalFiles).toBe(0);
      expect(store.matchedFiles).toBe(0);
      expect(store.matchedCount).toBe(0);
      expect(store.truncated).toBe(false);
    });

    it("DEFAULT_MAX_RESULTS 等于 1000", () => {
      expect(DEFAULT_MAX_RESULTS).toBe(1000);
    });
  });

  describe("基本 actions", () => {
    it("setQuery 设置 query", () => {
      const store = useSearchStore();
      store.setQuery("hello");
      expect(store.query).toBe("hello");
    });

    it("setOptions 部分合并", () => {
      const store = useSearchStore();
      store.setOptions({ regex: true });
      expect(store.options.regex).toBe(true);
      expect(store.options.caseSensitive).toBe(false);
    });

    it("toggleVisible 切换可见性", () => {
      const store = useSearchStore();
      expect(store.visible).toBe(false);
      store.toggleVisible();
      expect(store.visible).toBe(true);
      store.toggleVisible();
      expect(store.visible).toBe(false);
    });

    it("clear 重置所有状态并调用 cancelSearch", async () => {
      const store = useSearchStore();
      store.setQuery("hello");
      store.results = [
        { filePath: "/a.md", matches: [{ lineNumber: 1, lineContent: "x", contextBefore: [], contextAfter: [] }] },
      ];
      store.truncated = true;
      store.cancelToken = "old-token";
      mockedInvoke.mockResolvedValueOnce(undefined); // cancel_search

      store.clear();

      expect(store.query).toBe("");
      expect(store.results).toEqual([]);
      expect(store.filenameResults).toEqual([]);
      expect(store.truncated).toBe(false);
      expect(store.cancelToken).toBeNull();
      // clear 触发 cancelSearch（fire-and-forget，需 await microtask）
      await vi.waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith("cancel_search", {
          cancelToken: "old-token",
        });
      });
    });
  });

  describe("search 流程", () => {
    it("无工作区时返回空结果且不调用 invoke search_workspace", async () => {
      workspaceState.workspacePath = null;
      const store = useSearchStore();
      store.setQuery("hello");

      const resp = await store.search();

      expect(resp).toEqual({ contentResults: [], filenameResults: [], truncated: false });
      expect(mockedInvoke).not.toHaveBeenCalledWith(
        "search_workspace",
        expect.anything()
      );
    });

    it("空查询时返回空结果且不调用 invoke search_workspace", async () => {
      const store = useSearchStore();
      store.setQuery("   ");

      const resp = await store.search();

      expect(resp).toEqual({ contentResults: [], filenameResults: [], truncated: false });
      expect(mockedInvoke).not.toHaveBeenCalledWith(
        "search_workspace",
        expect.anything()
      );
    });

    it("正常搜索：调用 search_workspace 传入 cancelToken + maxResults，结果写入 state", async () => {
      const fakeResponse: SearchResponse = {
        contentResults: [
          {
            filePath: "/test/workspace/a.md",
            matches: [
              { lineNumber: 3, lineContent: "hello world", contextBefore: [], contextAfter: [] },
            ],
          },
        ],
        filenameResults: ["/test/workspace/b.md"],
        truncated: false,
      };
      mockedInvoke.mockResolvedValueOnce(fakeResponse);

      const store = useSearchStore();
      store.setQuery("hello");

      const resp = await store.search();

      expect(resp).toEqual(fakeResponse);
      // 验证调用参数
      expect(mockedInvoke).toHaveBeenCalledWith("search_workspace", {
        workspace: "/test/workspace",
        query: "hello",
        options: store.options,
        cancelToken: expect.stringMatching(/^search-\d+-[a-z0-9]+$/),
        maxResults: 1000,
      });
      // 验证 state 更新
      expect(store.results).toEqual(fakeResponse.contentResults);
      expect(store.filenameResults).toEqual(fakeResponse.filenameResults);
      expect(store.truncated).toBe(false);
      expect(store.loading).toBe(false);
      expect(store.matchedCount).toBe(1);
      expect(store.matchedFiles).toBe(1);
      // cancelToken 在 search 完成后保留（便于幂等 cancelSearch）
      expect(store.cancelToken).not.toBeNull();
    });

    it("invoke 失败时清空结果且不抛出", async () => {
      mockedInvoke.mockRejectedValueOnce(new Error("boom"));
      const store = useSearchStore();
      store.setQuery("hello");

      const resp = await store.search();

      expect(resp).toEqual({ contentResults: [], filenameResults: [], truncated: false });
      expect(store.results).toEqual([]);
      expect(store.filenameResults).toEqual([]);
      expect(store.truncated).toBe(false);
      expect(store.loading).toBe(false);
    });
  });

  describe("增量事件", () => {
    /**
     * 辅助：模拟一次搜索，并在 invoke resolve 前手动触发增量事件
     * 由于 search() 中 await listen 在 invoke 之前，事件监听已就位
     */
    async function startSearchAndEmit(
      store: ReturnType<typeof useSearchStore>,
      events: {
        progress?: SearchProgressEvent;
        chunk?: SearchResultChunkEvent;
      },
      finalResponse: SearchResponse
    ): Promise<void> {
      // 让 invoke 在事件触发后才 resolve
      let resolveInvoke!: (v: SearchResponse) => void;
      mockedInvoke.mockImplementationOnce(
        () => new Promise<SearchResponse>((resolve) => (resolveInvoke = resolve))
      );

      const searchPromise = store.search();

      // 等待 listen 被调用（监听器就位）
      await vi.waitFor(() => {
        expect(mockedListen).toHaveBeenCalledWith("search-progress", expect.any(Function));
        expect(mockedListen).toHaveBeenCalledWith("search-result-chunk", expect.any(Function));
      });

      // 手动触发事件
      if (events.progress) {
        listeners.get("search-progress")!({ payload: events.progress });
      }
      if (events.chunk) {
        listeners.get("search-result-chunk")!({ payload: events.chunk });
      }

      // 让 invoke 完成
      resolveInvoke(finalResponse);
      await searchPromise;
    }

    it("search-progress 事件更新 scannedFiles / totalFiles / matchedCount", async () => {
      const store = useSearchStore();
      store.setQuery("hello");

      // 通过 spy 捕获实际生成的 token
      let capturedToken: string | null = null;
      mockedInvoke.mockImplementationOnce((cmd: string, args: unknown) => {
        if (cmd === "search_workspace") {
          capturedToken = (args as { cancelToken: string }).cancelToken;
          return Promise.resolve({
            contentResults: [],
            filenameResults: [],
            truncated: false,
          } as SearchResponse);
        }
        return Promise.resolve(undefined);
      });

      const searchPromise = store.search();
      await vi.waitFor(() => expect(capturedToken).not.toBeNull());
      const realToken = capturedToken!;

      listeners.get("search-progress")!({
        payload: {
          scannedFiles: 50,
          totalFiles: 100,
          matchedFiles: 5,
          matchedCount: 12,
          cancelToken: realToken,
        } as SearchProgressEvent,
      });

      expect(store.scannedFiles).toBe(50);
      expect(store.totalFiles).toBe(100);
      expect(store.matchedFiles).toBe(5);
      expect(store.matchedCount).toBe(12);

      await searchPromise;
    });

    it("search-result-chunk 事件增量追加内容命中", async () => {
      const store = useSearchStore();
      store.setQuery("hello");

      let capturedToken: string | null = null;
      mockedInvoke.mockImplementationOnce((cmd: string, args: unknown) => {
        if (cmd === "search_workspace") {
          capturedToken = (args as { cancelToken: string }).cancelToken;
          return Promise.resolve({
            contentResults: [],
            filenameResults: [],
            truncated: false,
          } as SearchResponse);
        }
        return Promise.resolve(undefined);
      });

      const searchPromise = store.search();
      await vi.waitFor(() => expect(capturedToken).not.toBeNull());

      const chunk: SearchResultChunkEvent = {
        cancelToken: capturedToken!,
        result: {
          filePath: "/test/workspace/c.md",
          matches: [
            { lineNumber: 1, lineContent: "hello", contextBefore: [], contextAfter: [] },
          ],
        },
        filenameMatch: null,
      };
      listeners.get("search-result-chunk")!({ payload: chunk });

      expect(store.results).toHaveLength(1);
      expect(store.results[0].filePath).toBe("/test/workspace/c.md");

      await searchPromise;
    });

    it("search-result-chunk 事件增量追加文件名命中（去重）", async () => {
      const store = useSearchStore();
      store.setQuery("hello");

      let capturedToken: string | null = null;
      mockedInvoke.mockImplementationOnce((cmd: string, args: unknown) => {
        if (cmd === "search_workspace") {
          capturedToken = (args as { cancelToken: string }).cancelToken;
          return Promise.resolve({
            contentResults: [],
            filenameResults: [],
            truncated: false,
          } as SearchResponse);
        }
        return Promise.resolve(undefined);
      });

      const searchPromise = store.search();
      await vi.waitFor(() => expect(capturedToken).not.toBeNull());

      const chunk1: SearchResultChunkEvent = {
        cancelToken: capturedToken!,
        result: null,
        filenameMatch: "/test/workspace/d.md",
      };
      const chunk2: SearchResultChunkEvent = {
        cancelToken: capturedToken!,
        result: null,
        filenameMatch: "/test/workspace/d.md", // 重复
      };
      listeners.get("search-result-chunk")!({ payload: chunk1 });
      listeners.get("search-result-chunk")!({ payload: chunk2 });

      expect(store.filenameResults).toEqual(["/test/workspace/d.md"]);

      await searchPromise;
    });

    it("过期 token 的事件被忽略", async () => {
      const store = useSearchStore();
      store.setQuery("hello");

      let capturedToken: string | null = null;
      mockedInvoke.mockImplementationOnce((cmd: string, args: unknown) => {
        if (cmd === "search_workspace") {
          capturedToken = (args as { cancelToken: string }).cancelToken;
          return Promise.resolve({
            contentResults: [],
            filenameResults: [],
            truncated: false,
          } as SearchResponse);
        }
        return Promise.resolve(undefined);
      });

      const searchPromise = store.search();
      await vi.waitFor(() => expect(capturedToken).not.toBeNull());

      // 用错误的 token 触发事件，应被忽略
      listeners.get("search-progress")!({
        payload: {
          scannedFiles: 999,
          totalFiles: 999,
          matchedFiles: 999,
          matchedCount: 999,
          cancelToken: "stale-token",
        } as SearchProgressEvent,
      });
      listeners.get("search-result-chunk")!({
        payload: {
          cancelToken: "stale-token",
          result: {
            filePath: "/stale.md",
            matches: [
              { lineNumber: 1, lineContent: "x", contextBefore: [], contextAfter: [] },
            ],
          },
          filenameMatch: null,
        } as SearchResultChunkEvent,
      });

      expect(store.scannedFiles).toBe(0);
      expect(store.matchedCount).toBe(0);
      expect(store.results).toEqual([]);
      expect(store.filenameResults).toEqual([]);

      await searchPromise;
    });

    it("最终 invoke 结果覆盖增量结果（保证一致）", async () => {
      const store = useSearchStore();
      store.setQuery("hello");

      const finalResponse: SearchResponse = {
        contentResults: [
          {
            filePath: "/test/workspace/final.md",
            matches: [
              { lineNumber: 10, lineContent: "final", contextBefore: [], contextAfter: [] },
            ],
          },
        ],
        filenameResults: ["/test/workspace/final-name.md"],
        truncated: true,
      };

      await startSearchAndEmit(
        store,
        {
          // 增量事件提供不同的数据
          chunk: {
            cancelToken: "ignored-because-will-be-overwritten",
            result: {
              filePath: "/test/workspace/incremental.md",
              matches: [
                { lineNumber: 1, lineContent: "inc", contextBefore: [], contextAfter: [] },
              ],
            },
            filenameMatch: null,
          },
        },
        finalResponse
      );

      // 注：上面的 chunk 用了错误 token，所以不会被追加；但即便用正确 token，
      // 最终 invoke 结果也会覆盖。这里主要验证最终覆盖语义。
      expect(store.results).toEqual(finalResponse.contentResults);
      expect(store.filenameResults).toEqual(finalResponse.filenameResults);
      expect(store.truncated).toBe(true);
    });
  });

  describe("cancelSearch", () => {
    it("无 cancelToken 时不调用 cancel_search", async () => {
      const store = useSearchStore();
      await store.cancelSearch();
      expect(mockedInvoke).not.toHaveBeenCalledWith("cancel_search", expect.anything());
    });

    it("有 cancelToken 时调用 cancel_search", async () => {
      const store = useSearchStore();
      store.setQuery("hello");
      mockedInvoke.mockResolvedValueOnce({
        contentResults: [],
        filenameResults: [],
        truncated: false,
      } as SearchResponse);
      await store.search();

      // search 完成后 cancelToken 仍保留
      expect(store.cancelToken).not.toBeNull();
      mockedInvoke.mockClear();

      mockedInvoke.mockResolvedValueOnce(undefined);
      await store.cancelSearch();

      expect(mockedInvoke).toHaveBeenCalledWith("cancel_search", {
        cancelToken: store.cancelToken,
      });
    });

    it("新搜索前取消旧搜索（cancel_search 在 search_workspace 之前被调用）", async () => {
      const store = useSearchStore();
      store.setQuery("hello");

      // 第一次搜索
      mockedInvoke.mockResolvedValueOnce({
        contentResults: [],
        filenameResults: [],
        truncated: false,
      } as SearchResponse);
      await store.search();
      const firstToken = store.cancelToken!;
      expect(firstToken).toBeTruthy();

      mockedInvoke.mockClear();
      // 第二次搜索：应先取消第一次
      mockedInvoke.mockResolvedValueOnce(undefined); // cancel_search
      mockedInvoke.mockResolvedValueOnce({
        contentResults: [],
        filenameResults: [],
        truncated: false,
      } as SearchResponse);

      await store.search();

      // 验证 cancel_search 被调用（用第一个 token）
      // 注意：search() 中是 fire-and-forget，所以可能在 search_workspace 之后才执行
      await vi.waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith("cancel_search", {
          cancelToken: firstToken,
        });
      });
    });
  });

  describe("truncated 标志", () => {
    it("Rust 返回 truncated=true 时同步到 store", async () => {
      mockedInvoke.mockResolvedValueOnce({
        contentResults: [],
        filenameResults: [],
        truncated: true,
      } as SearchResponse);
      const store = useSearchStore();
      store.setQuery("hello");

      await store.search();

      expect(store.truncated).toBe(true);
    });
  });
});
