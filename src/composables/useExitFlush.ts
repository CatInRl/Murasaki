/**
 * 关闭前落盘（issue #185 / ADR-0017；多窗口见 spec #194；退出确认见 issue #346）
 *
 * 关闭窗口时 Rust 侧拦截 CloseRequested 并向**该窗口**发来 `app-close-requested`，
 * 前端在此处理本窗口的未保存改动，完成后调用 `close_window` 真正销毁本窗口：
 * - 有未保存改动且注入了 `resolveUnsaved` → 先弹一次汇总确认（保存 / 不保存 / 取消），
 *   选「取消」则**中止退出**（窗口留着，也不落盘），见 [ADR-0017](../../docs/adr/0017-close-interception-with-draft-flush-on-exit.md)
 * - 已命名且 dirty 的 tab → 写草稿（沿用 ADR-0001 草稿恢复机制）
 * - 全部 tab → 刷新本窗口的 tabs.json 槽位（未命名 tab 的内容只能靠这里保留）
 *
 * 关掉最后一个窗口时由 Rust 侧 `exit_if_no_other_windows` 退出应用，
 * 因此「关闭窗口」与「退出应用」不再需要前端区分；多窗口下每个窗口各自询问自己的未保存改动。
 *
 * 任何一步失败都不能让窗口关不掉：落盘异常只记日志，invoke 失败再兜底销毁窗口。
 */
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { fileSystem } from "../services/fileSystem";

/** 退出落盘所需的 tab 最小切片 */
export interface ExitFlushTab {
  id: string;
  path: string | null;
  content: string;
  lastMtime: number | null;
  isDirty: boolean;
}

export interface ExitFlushDeps {
  tabs: readonly ExitFlushTab[];
  saveDraft(path: string, content: string, knownMtime: number): Promise<void>;
  persist(): Promise<unknown>;
}

/** 落盘超时上限：超时后仍然退出，避免前端异常导致窗口关不掉 */
export const EXIT_FLUSH_TIMEOUT_MS = 3000;

/**
 * 把未保存改动落盘。始终 resolve（异常只记日志），调用方可直接继续退出。
 * 返回写草稿失败的 tab 数，便于单测断言。
 */
export async function flushUnsavedOnExit(deps: ExitFlushDeps): Promise<number> {
  let failed = 0;
  for (const tab of deps.tabs) {
    if (!tab.isDirty || !tab.path) continue;
    try {
      await deps.saveDraft(tab.path, tab.content, tab.lastMtime ?? 0);
    } catch (err) {
      failed++;
      console.error("[Murasaki] 退出前保存草稿失败:", err);
    }
  }
  try {
    await deps.persist();
  } catch (err) {
    console.error("[Murasaki] 退出前写入 tabs.json 失败:", err);
  }
  return failed;
}

export interface ExitFlushStoreSlice {
  tabs: readonly ExitFlushTab[];
  persist(): Promise<unknown>;
}

export interface ExitFlushOptions {
  /**
   * 有未保存改动时询问用户（返回 `false` = 取消退出，窗口不关也不落盘）。
   * 未注入则保持旧行为：不询问、静默落盘。
   */
  resolveUnsaved?: (dirty: readonly ExitFlushTab[]) => Promise<boolean>;
}

/**
 * 退出落盘接线：注册给 `app-close-requested` 事件使用。
 * 重复触发（用户连点关闭）只执行一次 —— 但如果用户选了「取消」，要复位让下次还能触发。
 */
export function useExitFlush(
  tabsStore: ExitFlushStoreSlice,
  options: ExitFlushOptions = {}
) {
  let inFlight = false;

  async function onExitRequested(): Promise<void> {
    if (inFlight) return;
    inFlight = true;

    // 未保存改动确认（issue #346）：这是「正常退出」的路径，让用户自己决定要不要保存；
    // 确认本身出差错时按「取消退出」处理 —— 宁可关不掉，也不要静默丢掉改动。
    const dirty = tabsStore.tabs.filter((tab) => tab.isDirty);
    if (dirty.length > 0 && options.resolveUnsaved) {
      let proceed = false;
      try {
        proceed = await options.resolveUnsaved(dirty);
      } catch (err) {
        console.error("[Murasaki] 退出前的未保存确认失败，按「取消退出」处理:", err);
      }
      if (!proceed) {
        inFlight = false;
        // issue #377：Rust 侧 ClosingState 已登记本窗口，必须显式退出拦截，
        // 否则下次 CloseRequested 被 intercept_close_request 吞掉，窗口永远关不掉
        try {
          await invoke("cancel_close");
        } catch (err) {
          console.error("[Murasaki] cancel_close 失败:", err);
        }
        return;
      }
    }

    try {
      await Promise.race([
        flushUnsavedOnExit({
          tabs: tabsStore.tabs,
          saveDraft: (path, content, knownMtime) =>
            fileSystem.saveDraft(path, content, knownMtime),
          persist: () => tabsStore.persist(),
        }),
        new Promise((resolve) => setTimeout(resolve, EXIT_FLUSH_TIMEOUT_MS)),
      ]);
    } catch (err) {
      console.error("[Murasaki] 退出前落盘异常:", err);
    } finally {
      try {
        await invoke("close_window");
      } catch (err) {
        // 兜底：Rust 侧未能关闭时强制销毁本窗口，保证窗口关得掉
        console.error("[Murasaki] close_window 失败，强制销毁窗口:", err);
        void getCurrentWebviewWindow().destroy().catch(() => {});
      }
    }
  }

  return { onExitRequested };
}
