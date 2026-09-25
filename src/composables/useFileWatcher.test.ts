/**
 * 文件监听测试（issue #193）
 *
 * 1. 纯函数 shouldRefreshTree：哪些外部变更需要刷新文件树
 * 2. 事件编排：listen → 归并 → flush → onExternalChange / onTreeChange（含合并去抖）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ===== Mock Tauri 事件与命令 =====
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// ===== Mock 依赖的 store（composable 内部直接 useXxxStore()）=====
const workspaceState = { workspacePath: "C:/ws" as string | null };
vi.mock("../stores/useWorkspaceStore", () => ({
  useWorkspaceStore: () => workspaceState,
}));

const tabsState = { tabs: [] as Array<{ path: string | null }> };
vi.mock("../stores/useTabsStore", () => ({
  useTabsStore: () => tabsState,
}));

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  useFileWatcher,
  shouldRefreshTree,
  type FileChangePayload,
} from "./useFileWatcher";

const mockedListen = listen as unknown as ReturnType<typeof vi.fn>;
const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

type ListenCallback = (event: { payload: FileChangePayload }) => void;

describe("shouldRefreshTree", () => {
  const ws = "C:/ws";

  it("工作区内的结构变化需要刷新文件树", () => {
    expect(shouldRefreshTree({ path: "C:/ws/a.md", kind: "create" }, ws)).toBe(true);
    expect(shouldRefreshTree({ path: "C:/ws/sub/a.md", kind: "remove" }, ws)).toBe(true);
    expect(shouldRefreshTree({ path: "C:/ws/a.md", kind: "rename" }, ws)).toBe(true);
  });

  it("内容修改不刷新（应用内保存同样产生 modify 事件）", () => {
    expect(shouldRefreshTree({ path: "C:/ws/a.md", kind: "modify" }, ws)).toBe(false);
  });

  it("工作区外的路径不刷新", () => {
    expect(shouldRefreshTree({ path: "D:/other/a.md", kind: "create" }, ws)).toBe(false);
    // 兄弟前缀目录（C:/ws2）不算工作区内
    expect(shouldRefreshTree({ path: "C:/ws2/a.md", kind: "create" }, ws)).toBe(false);
  });

  it("无工作区时不刷新", () => {
    expect(shouldRefreshTree({ path: "C:/ws/a.md", kind: "create" }, null)).toBe(false);
  });
});

describe("useFileWatcher 事件编排", () => {
  let callback: ListenCallback | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    // onBeforeUnmount 在组件外调用会告警，静默它
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    callback = null;
    workspaceState.workspacePath = "C:/ws";
    tabsState.tabs = [];

    mockedListen.mockReset();
    mockedInvoke.mockReset();
    mockedInvoke.mockResolvedValue(undefined);
    mockedListen.mockImplementation(async (_event: string, cb: ListenCallback) => {
      callback = cb;
      return () => {};
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeWatcher() {
    const onExternalChange = vi.fn(async () => {});
    const onTreeChange = vi.fn();
    const watcher = useFileWatcher({ onExternalChange, onTreeChange });
    return { watcher, onExternalChange, onTreeChange };
  }

  it("启动时按工作区路径注册监听", async () => {
    const { watcher } = makeWatcher();
    await watcher.start();
    expect(mockedInvoke).toHaveBeenCalledWith("start_watching", { path: "C:/ws" });
    expect(mockedListen).toHaveBeenCalledWith("file-changed", expect.any(Function));
  });

  it("已打开 tab 的外部内容修改 → 回调 onExternalChange，不刷树", async () => {
    tabsState.tabs = [{ path: "C:/ws/a.md" }];
    const { watcher, onExternalChange, onTreeChange } = makeWatcher();
    await watcher.start();

    callback!({ payload: { path: "C:/ws/a.md", kind: "modify" } });
    await vi.advanceTimersByTimeAsync(300);

    expect(onExternalChange).toHaveBeenCalledTimes(1);
    expect(onExternalChange).toHaveBeenCalledWith("C:/ws/a.md");

    await vi.advanceTimersByTimeAsync(500);
    expect(onTreeChange).not.toHaveBeenCalled();
  });

  it("工作区内的新建爆发只刷新一次文件树", async () => {
    const { watcher, onTreeChange } = makeWatcher();
    await watcher.start();

    callback!({ payload: { path: "C:/ws/new1.md", kind: "create" } });
    callback!({ payload: { path: "C:/ws/new2.md", kind: "create" } });
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(500);

    expect(onTreeChange).toHaveBeenCalledTimes(1);
  });

  it("工作区外与未打开 tab 的变更不触发任何回调", async () => {
    const { watcher, onExternalChange, onTreeChange } = makeWatcher();
    await watcher.start();

    callback!({ payload: { path: "D:/other/x.md", kind: "create" } });
    callback!({ payload: { path: "C:/ws/not-open.md", kind: "modify" } });
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(500);

    expect(onExternalChange).not.toHaveBeenCalled();
    expect(onTreeChange).not.toHaveBeenCalled();
  });

  it("同一路径归并时结构变化优先于内容修改", async () => {
    tabsState.tabs = [{ path: "C:/ws/a.md" }];
    const { watcher, onExternalChange, onTreeChange } = makeWatcher();
    await watcher.start();

    // 重命名通常伴随 modify 事件，不能因后到的 modify 丢掉结构变化
    callback!({ payload: { path: "C:/ws/a.md", kind: "modify" } });
    callback!({ payload: { path: "C:/ws/a.md", kind: "rename" } });
    await vi.advanceTimersByTimeAsync(300);

    expect(onExternalChange).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(onTreeChange).toHaveBeenCalledTimes(1);
  });

  it("stop 后未触发的树刷新被取消", async () => {
    const { watcher, onTreeChange } = makeWatcher();
    await watcher.start();

    callback!({ payload: { path: "C:/ws/x.md", kind: "create" } });
    await watcher.stop();
    await vi.advanceTimersByTimeAsync(1000);

    expect(onTreeChange).not.toHaveBeenCalled();
  });
});
