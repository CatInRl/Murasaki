/**
 * 关闭前落盘（issue #185 / ADR-0017；多窗口见 spec #194）
 *
 * 关闭窗口时 Rust 侧拦截 CloseRequested 并向**该窗口**发来 `app-close-requested`，
 * 前端在此把本窗口的未保存改动静默落盘（不弹对话框），完成后调用 `close_window`
 * 真正销毁本窗口：
 * - 已命名且 dirty 的 tab → 写草稿（沿用 ADR-0001 草稿恢复机制）
 * - 全部 tab → 刷新本窗口的 tabs.json 槽位（未命名 tab 的内容只能靠这里保留）
 *
 * 关掉最后一个窗口时由 Rust 侧 `exit_if_no_other_windows` 退出应用，
 * 因此「关闭窗口」与「退出应用」不再需要前端区分。
 *
 * 任何一步失败都不能让窗口关不掉：落盘异常只记日志，invoke 失败再兜底销毁窗口。
 */
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { fileSystem } from "../services/fileSystem";

/** 退出落盘所需的 tab 最小切片 */
export interface ExitFlushTab {
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

/**
 * 退出落盘接线：注册给 `app-close-requested` 事件使用。
 * 重复触发（用户连点关闭）只执行一次。
 */
export function useExitFlush(tabsStore: ExitFlushStoreSlice) {
  let inFlight = false;

  async function onExitRequested(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
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
