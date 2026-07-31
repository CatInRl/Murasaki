import { describe, it, expect, beforeEach, vi } from "vitest";
import { ref, effectScope } from "vue";
import { useRecentMenuSync } from "./useRecentMenuSync";

// ===== Mock @tauri-apps/api/core 的 invoke =====
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";

const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

/** 构造 fake persistence（getRecent* 从 recentEntries 动态过滤） */
function makePersistence(folders: string[] = [], files: string[] = []) {
  const recentEntries = ref([
    ...folders.map((p) => ({ path: p, type: "folder" as const, openedAt: 0 })),
    ...files.map((p) => ({ path: p, type: "file" as const, openedAt: 0 })),
  ]);
  return {
    recentEntries,
    getRecentFolders: vi.fn((limit = 5) =>
      recentEntries.value.filter((e) => e.type === "folder").slice(0, limit)
    ),
    getRecentFiles: vi.fn((limit = 5) =>
      recentEntries.value.filter((e) => e.type === "file").slice(0, limit)
    ),
  };
}

beforeEach(() => {
  mockedInvoke.mockReset();
});

describe("useRecentMenuSync", () => {
  describe("syncNow", () => {
    it("调用 invoke update_recent_menu 传入 folders + files", async () => {
      const persistence = makePersistence(["/a", "/b"], ["1.md", "2.md"]);
      const initialized = ref(true);
      const { syncNow } = useRecentMenuSync({ persistence, initialized });

      await syncNow();

      expect(mockedInvoke).toHaveBeenCalledWith("update_recent_menu", {
        folders: ["/a", "/b"],
        files: ["1.md", "2.md"],
      });
    });

    it("invoke 失败时 warn 但不抛出", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockedInvoke.mockRejectedValueOnce(new Error("rpc down"));
      const persistence = makePersistence(["/a"], []);
      const { syncNow } = useRecentMenuSync({ persistence, initialized: ref(true) });

      await expect(syncNow()).resolves.not.toThrow();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe("in-flight 锁 + 重排", () => {
    it("并发调用不重复 invoke（in-flight 锁）", async () => {
      const resolvers: (() => void)[] = [];
      mockedInvoke.mockImplementation(
        () => new Promise<void>((r) => { resolvers.push(r); })
      );
      const persistence = makePersistence(["/a"], []);
      const { syncNow } = useRecentMenuSync({ persistence, initialized: ref(true) });

      const p1 = syncNow();
      const p2 = syncNow(); // in-flight，标记 scheduled
      await Promise.resolve();
      expect(mockedInvoke).toHaveBeenCalledTimes(1);
      // 解开第 1 次 invoke → do-while 检测 scheduled=true → 第 2 次 invoke
      resolvers[0]();
      await Promise.resolve();
      expect(mockedInvoke).toHaveBeenCalledTimes(2);
      // 解开第 2 次 invoke → scheduled=false → 循环结束
      resolvers[1]();
      await p1;
      await p2;
    });

    it("scheduled 在 flight 期间清零后不再重排", async () => {
      const resolvers: (() => void)[] = [];
      mockedInvoke.mockImplementation(
        () => new Promise<void>((r) => { resolvers.push(r); })
      );
      const persistence = makePersistence(["/a"], []);
      const { syncNow } = useRecentMenuSync({ persistence, initialized: ref(true) });

      const p1 = syncNow();
      await Promise.resolve();
      // 不触发第二次 schedule，解开 invoke → scheduled=false → 不重排
      resolvers[0]();
      await p1;
      expect(mockedInvoke).toHaveBeenCalledTimes(1);
    });
  });

  describe("watcher + debounce", () => {
    it("recentEntries 变化触发 debounced sync（150ms 后）", async () => {
      vi.useFakeTimers();
      const scope = effectScope();
      const folders = ["/a"];
      const persistence = makePersistence(folders, []);
      const initialized = ref(true);

      await scope.run(async () => {
        const { syncNow } = useRecentMenuSync({ persistence, initialized });
        void syncNow;
        mockedInvoke.mockResolvedValue(undefined);

        persistence.recentEntries.value.push({ path: "/b", type: "folder", openedAt: 0 });
        // 未到 150ms，不触发
        await vi.advanceTimersByTimeAsync(100);
        expect(mockedInvoke).not.toHaveBeenCalledWith("update_recent_menu", expect.anything());

        await vi.advanceTimersByTimeAsync(60);
        expect(mockedInvoke).toHaveBeenCalledWith("update_recent_menu", {
          folders: ["/a", "/b"],
          files: [],
        });
      });
      scope.stop();
      vi.useRealTimers();
    });

    it("initialized=false 时 watcher 不触发 sync", async () => {
      vi.useFakeTimers();
      const scope = effectScope();
      const persistence = makePersistence(["/a"], []);
      const initialized = ref(false);

      await scope.run(async () => {
        useRecentMenuSync({ persistence, initialized });
        mockedInvoke.mockResolvedValue(undefined);

        persistence.recentEntries.value.push({ path: "/b", type: "folder", openedAt: 0 });
        await vi.advanceTimersByTimeAsync(200);
        expect(mockedInvoke).not.toHaveBeenCalled();
      });
      scope.stop();
      vi.useRealTimers();
    });
  });
});
