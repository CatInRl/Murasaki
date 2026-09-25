/**
 * 退出前落盘测试（issue #185 / ADR-0017）
 *
 * 只测纯逻辑 flushUnsavedOnExit：哪些 tab 写草稿、异常是否被吞（不能让窗口关不掉）。
 */
import { describe, it, expect, vi } from "vitest";
import { flushUnsavedOnExit, type ExitFlushTab } from "./useExitFlush";

function tab(overrides: Partial<ExitFlushTab> = {}): ExitFlushTab {
  return {
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
