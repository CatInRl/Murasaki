/**
 * 退出前落盘测试（issue #185 / ADR-0017；退出确认 issue #346）
 *
 * - flushUnsavedOnExit：纯逻辑，哪些 tab 写草稿、异常是否被吞（不能让窗口关不掉）
 * - useExitFlush：接线层，未保存改动先问用户（保存 / 不保存 / 取消），取消要能中止退出
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { flushUnsavedOnExit, useExitFlush, type ExitFlushTab } from "./useExitFlush";
import { fileSystem } from "../services/fileSystem";

// 接线层会碰 Tauri IPC 与草稿落盘：这里替身化，测试只关心编排顺序
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ destroy: vi.fn(async () => undefined) }),
}));
vi.mock("../services/fileSystem", () => ({
  fileSystem: { saveDraft: vi.fn(async () => undefined) },
}));

/** 接线层内部固定走 fileSystem.saveDraft（不取注入的 saveDraft），断言要用这个替身 */
const saveDraftSpy = fileSystem.saveDraft as unknown as ReturnType<typeof vi.fn>;

function tab(overrides: Partial<ExitFlushTab> = {}): ExitFlushTab {
  return {
    id: "t1",
    path: "C:/ws/a.md",
    content: "unsaved",
    lastMtime: 123,
    isDirty: true,
    ...overrides,
  };
}

function makeDeps(tabs: ExitFlushTab[]) {
  const saveDraft = vi.fn(async () => {});
  const persist = vi.fn(async () => {});
  return { deps: { tabs, saveDraft, persist }, saveDraft, persist };
}

describe("flushUnsavedOnExit", () => {
  it("dirty 且已命名的 tab 写草稿，带上 lastMtime", async () => {
    const { deps, saveDraft, persist } = makeDeps([tab()]);
    await flushUnsavedOnExit(deps);
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(saveDraft).toHaveBeenCalledWith("C:/ws/a.md", "unsaved", 123);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("未改动（isDirty=false）的 tab 不写草稿", async () => {
    const { deps, saveDraft } = makeDeps([tab({ isDirty: false })]);
    await flushUnsavedOnExit(deps);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("未命名 tab（path=null）不写草稿，但内容靠 persist 保留", async () => {
    const { deps, saveDraft, persist } = makeDeps([tab({ path: null })]);
    await flushUnsavedOnExit(deps);
    expect(saveDraft).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("lastMtime 为 null 时草稿 knownMtime 记 0", async () => {
    const { deps, saveDraft } = makeDeps([tab({ lastMtime: null })]);
    await flushUnsavedOnExit(deps);
    expect(saveDraft).toHaveBeenCalledWith("C:/ws/a.md", "unsaved", 0);
  });

  it("草稿写入失败被吞掉并计数，其余 tab 继续落盘", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const saveDraft = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    const persist = vi.fn(async () => {});
    const failed = await flushUnsavedOnExit({
      tabs: [tab(), tab({ path: "C:/ws/b.md" })],
      saveDraft,
      persist,
    });
    expect(failed).toBe(1);
    expect(saveDraft).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("persist 失败不抛出（保证仍能退出）", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const persist = vi.fn(async () => {
      throw new Error("store locked");
    });
    await expect(
      flushUnsavedOnExit({ tabs: [], saveDraft: vi.fn(async () => {}), persist })
    ).resolves.toBe(0);
    warn.mockRestore();
  });
});

describe("useExitFlush（退出确认 #346）", () => {
  beforeEach(() => {
    saveDraftSpy.mockClear();
  });

  it("无未保存改动：不询问，直接落盘", async () => {
    const { deps, persist } = makeDeps([tab({ isDirty: false })]);
    const resolveUnsaved = vi.fn(async () => false);
    await useExitFlush(deps, { resolveUnsaved }).onExitRequested();
    expect(resolveUnsaved).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("未注入 resolveUnsaved：保持旧行为（不询问、静默落盘）", async () => {
    const { deps, persist } = makeDeps([tab()]);
    await useExitFlush(deps).onExitRequested();
    expect(saveDraftSpy).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("选「继续退出」：把 dirty tab 交给询问方后照旧落盘", async () => {
    const { deps, persist } = makeDeps([tab()]);
    const resolveUnsaved = vi.fn(async () => true);
    await useExitFlush(deps, { resolveUnsaved }).onExitRequested();
    expect(resolveUnsaved).toHaveBeenCalledWith([expect.objectContaining({ id: "t1" })]);
    expect(saveDraftSpy).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("选「取消」：不落盘、不关窗，且下次仍能触发（否则窗口就再也关不掉了）", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, persist } = makeDeps([tab()]);
    const resolveUnsaved = vi.fn(async () => false);
    const { onExitRequested } = useExitFlush(deps, { resolveUnsaved });

    await onExitRequested();
    expect(saveDraftSpy).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();

    await onExitRequested();
    expect(resolveUnsaved).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("确认过程抛错：按「取消退出」处理（宁可关不掉也不静默丢改动）", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = makeDeps([tab()]);
    const resolveUnsaved = vi.fn(async () => {
      throw new Error("dialog failed");
    });
    await useExitFlush(deps, { resolveUnsaved }).onExitRequested();
    expect(saveDraftSpy).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
