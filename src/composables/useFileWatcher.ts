import { watch, onBeforeUnmount } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { useTabsStore } from "../stores/useTabsStore";
import { isPathUnder } from "../utils/path";

/** 外部变更事件的合并窗口（毫秒）：同一爆发期的多个事件合并为一次处理 */
const EXTERNAL_CHANGE_THROTTLE_MS = 300;

/** 文件树刷新的合并窗口（毫秒）：从首个结构变化起算，避免一次爆发触发多次全量重扫 */
const TREE_REFRESH_DEBOUNCE_MS = 500;

/**
 * 文件监听 composable
 * - 工作区打开时启动 Rust 端 notify 监听
 * - 收到 `file-changed` 事件后分两路处理：
 *   1. 已打开 tab 的外部内容修改 → `onExternalChange`（弹窗/重载）
 *   2. 工作区内的结构变化（新建/删除/重命名）→ 合并后 `onTreeChange`（刷新文件树）
 * - 工作区关闭/切换时停止监听
 *
 * 注意：spec 要求"应用获得焦点/tab 切换时检测外部修改"。
 * 这里通过 notify 实时推送 + 节流避免抖动。
 * 节流由调用方在 onExternalChange 中处理。
 */

/** `file-changed` 事件负载（Rust 侧 watcher.rs 推送） */
export interface FileChangePayload {
  path: string;
  /**
   * 变更类别：
   * - `modify` 内容修改（含编辑器保存）
   * - `create` / `remove` / `rename` 结构变化（会改变文件树）
   */
  kind: "create" | "modify" | "rename" | "remove";
}

/**
 * 该变更是否需要刷新文件树（纯函数，便于单测）
 * - 仅结构变化需要：内容修改不改变树的形状与条目
 * - 路径必须位于当前工作区内（工作区外的改动不进树）
 */
export function shouldRefreshTree(
  change: FileChangePayload,
  workspacePath: string | null
): boolean {
  if (change.kind === "modify") return false;
  if (!workspacePath) return false;
  return isPathUnder(workspacePath, change.path);
}

export interface UseFileWatcherOptions {
  /** 收到外部修改通知时调用（参数：变更文件的绝对路径） */
  onExternalChange: (path: string) => void | Promise<void>;
  /** 工作区内发生结构变化（新建/删除/重命名）时调用，已做合并去抖 */
  onTreeChange?: () => void;
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
  const pendingChanges = new Map<string, FileChangePayload>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** 文件树刷新合并窗口：从首个结构变化起算，一次爆发只刷新一次 */
  let treeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let treeDirty = false;

  function scheduleTreeRefresh(): void {
    if (!options.onTreeChange) return;
    treeDirty = true;
    if (treeRefreshTimer) return;
    treeRefreshTimer = setTimeout(() => {
      treeRefreshTimer = null;
      if (!treeDirty) return;
      treeDirty = false;
      options.onTreeChange?.();
    }, TREE_REFRESH_DEBOUNCE_MS);
  }

  /** 同一路径的多次事件归并：结构变化优先于内容修改（如重命名会伴随 modify） */
  function mergeChange(change: FileChangePayload): void {
    const prev = pendingChanges.get(change.path);
    if (prev && prev.kind !== "modify") return;
    pendingChanges.set(change.path, change);
  }

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const changes = Array.from(pendingChanges.values());
      pendingChanges.clear();
      for (const change of changes) {
        // 仅处理当前已打开的 tab 对应的文件
        const isOpened = tabsStore.tabs.some((t) => t.path === change.path);
        if (isOpened) {
          void options.onExternalChange(change.path);
        }
        // 工作区内的结构变化 → 合并后刷新文件树
        if (shouldRefreshTree(change, workspace.workspacePath)) {
          scheduleTreeRefresh();
        }
      }
    }, EXTERNAL_CHANGE_THROTTLE_MS);
  }

  async function start(): Promise<void> {
    // 监听 file-changed 事件
    if (!unlistenFileChanged) {
      unlistenFileChanged = await listen<FileChangePayload>("file-changed", (event) => {
        const change = event.payload;
        if (change?.path) {
          mergeChange(change);
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
    if (treeRefreshTimer) {
      clearTimeout(treeRefreshTimer);
      treeRefreshTimer = null;
    }
    treeDirty = false;
    pendingChanges.clear();
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
