/**
 * 退出前落盘测试（issue #185 / ADR-0017；退出确认 #346）
 *
 * - flushUnsavedOnExit：纯逻辑，草稿是否落盘、异常是否被吞（不能让窗口关不掉）
 * - useExitFlush：接线层，未保存改动先问用户（保存 / 不保存 / 取消），取消要能中止退出
 *
 * 草稿落盘已收敛到编辑会话（ADR-0022），这里替身化 store 的 flush/discard 入口。
 */
import { describe, it, expect, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { flushUnsavedOnExit, useExitFlush, type ExitFlushTab } from "./useExitFlush";

// 接线层会碰 Tauri IPC：这里替身化，测试只关心编排顺序
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
const invokeSpy = invoke as unknown as ReturnType<typeof vi.fn>;
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ destroy: vi.fn(async () => undefined) }),
}));

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

/** 断言粒度从「saveDraft 被调用」变成「会话 flush 被调用」 */
function makeDeps(tabs: ExitFlushTab[]) {
  const flushAllDrafts = vi.fn(async () => 0);
  const discardAllDrafts = vi.fn(async () => {});
  const persist = vi.fn(async () => {});
  return {
    deps: { tabs, flushAllDrafts, discardAllDrafts, persist },
    flushAllDrafts,
    discardAllDrafts,
    persist,
  };
}

describe("flushUnsavedOnExit", () => {
  it("把草稿落盘入口交给会话 flush，并刷新 tabs.json", async () => {
    const { deps, flushAllDrafts, persist } = makeDeps([tab()]);
    await flushUnsavedOnExit(deps);
    expect(flushAllDrafts).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("无脏会话时仍然刷新 tabs.json（未命名 tab 的内容只能靠这里保留）", async () => {
    const { deps, flushAllDrafts, persist } = makeDeps([tab({ isDirty: false })]);
    await flushUnsavedOnExit(deps);
    expect(flushAllDrafts).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("未命名 tab 不阻断落盘（会话不写草稿，内容靠 persist 保留）", async () => {
    const { deps, persist } = makeDeps([tab({ path: null })]);
    await flushUnsavedOnExit(deps);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("草稿写入失败被吞掉并向上计数，其余流程继续", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const persist = vi.fn(async () => {});
    const failed = await flushUnsavedOnExit({
      tabs: [tab()],
      flushAllDrafts: vi.fn(async () => 1),
      discardAllDrafts: vi.fn(async () => {}),
      persist,
    });
    expect(failed).toBe(1);
    expect(persist).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("persist 失败不抛出（保证仍能退出）", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const persist = vi.fn(async () => {
      throw new Error("store locked");
    });
    await expect(
      flushUnsavedOnExit({
        tabs: [],
        flushAllDrafts: vi.fn(async () => 0),
        discardAllDrafts: vi.fn(async () => {}),
        persist,
      })
    ).resolves.toBe(0);
    warn.mockRestore();
  });

  it("「不保存」走 discard：不 flush 草稿，但清掉已有草稿并刷新 tabs.json", async () => {
    const flushAllDrafts = vi.fn(async () => 0);
    const discardAllDrafts = vi.fn(async () => {});
    const persist = vi.fn(async () => {});
    const failed = await flushUnsavedOnExit({
      tabs: [tab()],
      flushAllDrafts,
      discardAllDrafts,
      persist,
      writeDrafts: false,
    });
    expect(flushAllDrafts).not.toHaveBeenCalled();
    expect(discardAllDrafts).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(failed).toBe(0);
  });
});

describe("useExitFlush（退出确认 #346）", () => {
  it("无未保存改动：不询问，直接落盘", async () => {
    const { deps, persist } = makeDeps([tab({ isDirty: false })]);
    const resolveUnsaved = vi.fn(async () => "cancel" as const);
    await useExitFlush(deps, { resolveUnsaved }).onExitRequested();
    expect(resolveUnsaved).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("未注入 resolveUnsaved：保持旧行为（不询问、静默落盘）", async () => {
    const { deps, flushAllDrafts, persist } = makeDeps([tab()]);
    await useExitFlush(deps).onExitRequested();
    expect(flushAllDrafts).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("选「继续退出」：把 dirty tab 交给询问方后照旧落盘", async () => {
    const { deps, flushAllDrafts, persist } = makeDeps([tab()]);
    const resolveUnsaved = vi.fn(async () => "save" as const);
    await useExitFlush(deps, { resolveUnsaved }).onExitRequested();
    expect(resolveUnsaved).toHaveBeenCalledWith([expect.objectContaining({ id: "t1" })]);
    expect(flushAllDrafts).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("选「取消」：不落盘、不关窗，且下次仍能触发（否则窗口就再也关不掉了）", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, flushAllDrafts, persist } = makeDeps([tab()]);
    const resolveUnsaved = vi.fn(async () => "cancel" as const);
    const { onExitRequested } = useExitFlush(deps, { resolveUnsaved });

    invokeSpy.mockClear();
    await onExitRequested();
    expect(flushAllDrafts).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    // issue #377：Rust ClosingState 已登记本窗口，取消时必须显式退出拦截，
    // 否则下次 CloseRequested 被 intercept_close_request 吞掉，关闭按钮永久失效
    expect(invokeSpy).toHaveBeenCalledWith("cancel_close");

    await onExitRequested();
    expect(resolveUnsaved).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("选「不保存」：不写草稿、清掉已有草稿，但仍然刷新 tabs.json 并关窗（#426）", async () => {
    const { deps, flushAllDrafts, discardAllDrafts, persist } = makeDeps([tab()]);
    const resolveUnsaved = vi.fn(async () => "discard" as const);
    await useExitFlush(deps, { resolveUnsaved }).onExitRequested();
    expect(resolveUnsaved).toHaveBeenCalled();
    expect(flushAllDrafts).not.toHaveBeenCalled();
    expect(discardAllDrafts).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("确认过程抛错：按「取消退出」处理，同样要退出 Rust 拦截", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, flushAllDrafts } = makeDeps([tab()]);
    const resolveUnsaved = vi.fn(async () => {
      throw new Error("dialog failed");
    });
    invokeSpy.mockClear();
    await useExitFlush(deps, { resolveUnsaved }).onExitRequested();
    expect(flushAllDrafts).not.toHaveBeenCalled();
    expect(invokeSpy).toHaveBeenCalledWith("cancel_close");
    warn.mockRestore();
  });
});
