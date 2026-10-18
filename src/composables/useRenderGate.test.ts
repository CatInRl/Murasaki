import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRenderGate } from "./useRenderGate";

/**
 * #431：预览渲染节流门。
 *
 * - 防抖：窗口内多次变更只渲染一次；
 * - 代际：新的调度让在途渲染立刻过期，不再操作 DOM。
 */
describe("createRenderGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("防抖窗口内多次调度只渲染一次", async () => {
    const run = vi.fn(async () => {});
    const gate = createRenderGate({ debounceMs: 200, run });

    gate.schedule();
    gate.schedule();
    gate.schedule();
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("窗口结束后再次调度会重新渲染（持续输入不会被无限延后）", async () => {
    const run = vi.fn(async () => {});
    const gate = createRenderGate({ debounceMs: 200, run });

    gate.schedule();
    await vi.advanceTimersByTimeAsync(200);
    gate.schedule();
    await vi.advanceTimersByTimeAsync(200);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("在途渲染被新调度判为过期", async () => {
    let staleWhenRunning: boolean | null = null;
    let resolveFirst: (() => void) | undefined;
    const run = vi.fn(async (isStale: () => boolean) => {
      staleWhenRunning = isStale();
      await new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      // 等待期间又有新调度 → 这里应已过期
      staleWhenRunning = isStale();
    });
    const gate = createRenderGate({ debounceMs: 200, run });

    gate.schedule();
    await vi.advanceTimersByTimeAsync(200);
    expect(staleWhenRunning).toBe(false);

    gate.schedule();
    resolveFirst?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(staleWhenRunning).toBe(true);
  });

  it("首次调度立即执行（避免首屏空白）", () => {
    const run = vi.fn(async () => {});
    const gate = createRenderGate({ debounceMs: 200, run, immediateFirst: true });

    gate.schedule();
    expect(run).toHaveBeenCalledTimes(1);

    gate.schedule();
    expect(run).toHaveBeenCalledTimes(1); // 之后的调度走防抖
  });

  it("cancel 取消排队中的渲染并让在途渲染过期", async () => {
    let stale: boolean | null = null;
    let resolveFirst: (() => void) | undefined;
    const run = vi.fn(async (isStale: () => boolean) => {
      await new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      stale = isStale();
    });
    const gate = createRenderGate({ debounceMs: 200, run, immediateFirst: true });

    gate.schedule();
    gate.schedule(); // 排队一个防抖任务
    gate.cancel();

    resolveFirst?.();
    await vi.advanceTimersByTimeAsync(500);

    expect(run).toHaveBeenCalledTimes(1); // 排队的那个没有执行
    expect(stale).toBe(true);
  });
});
