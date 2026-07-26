import { watch, onBeforeUnmount } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { useTabsStore } from "../stores/useTabsStore";

/**
 * 文件监听 composable
 * - 工作区打开时启动 Rust 端 notify 监听
 * - 收到 `file-changed` 事件后，调用回调
 * - 工作区关闭/切换时停止监听
 *
 * 注意：spec 要求"应用获得焦点/tab 切换时检测外部修改"。
 * 这里通过 notify 实时推送 + 节流避免抖动。
 * 节流由调用方在 onExternalChange 中处理。
 */

export interface UseFileWatcherOptions {
  /** 收到外部修改通知时调用（参数：变更文件的绝对路径） */
  onExternalChange: (path: string) => void | Promise<void>;
}

export interface UseFileWatcher {
  /** 启动监听当前工作区 */
  start(): Promise<void>;
  /** 停止监听 */
  stop(): Promise<void>;
}

export function useFileWatcher(options: UseFileWatcherOptions): UseFileWatcher {
  const workspace = useWorkspaceStore();
  const tabsStore = useTabsStore();

  let unlistenFileChanged: UnlistenFn | null = null;
  let currentWatchedPath: string | null = null;

  /** 节流：避免短时间内对同一文件多次回调 */
  const pendingPaths = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const paths = Array.from(pendingPaths);
      pendingPaths.clear();
      for (const p of paths) {
        // 仅处理当前已打开的 tab 对应的文件
        const isOpened = tabsStore.tabs.some((t) => t.path === p);
        if (isOpened) {
          void options.onExternalChange(p);
        }
      }
    }, 300);
  }

  async function start(): Promise<void> {
    // 监听 file-changed 事件
    if (!unlistenFileChanged) {
      unlistenFileChanged = await listen<string>("file-changed", (event) => {
        const path = event.payload;
        if (path) {
          pendingPaths.add(path);
          scheduleFlush();
        }
      });
    }

    // 启动工作区监听
    const wsPath = workspace.workspacePath;
    if (wsPath && wsPath !== currentWatchedPath) {
      // 先停止旧监听
      if (currentWatchedPath) {
        await invoke("stop_watching", { path: currentWatchedPath }).catch(() => {});
      }
      try {
        await invoke("start_watching", { path: wsPath });
        currentWatchedPath = wsPath;
      } catch (err) {
        console.error("启动文件监听失败:", err);
      }
    }
  }

  async function stop(): Promise<void> {
    if (currentWatchedPath) {
      await invoke("stop_watching", { path: currentWatchedPath }).catch(() => {});
      currentWatchedPath = null;
    }
    if (unlistenFileChanged) {
      unlistenFileChanged();
      unlistenFileChanged = null;
    }
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    pendingPaths.clear();
  }

  // 工作区变化时自动重启监听
  watch(
    () => workspace.workspacePath,
    () => {
      void start();
    }
  );

  onBeforeUnmount(() => {
    void stop();
  });

  return {
    start,
    stop,
  };
}
