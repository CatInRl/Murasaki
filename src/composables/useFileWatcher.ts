import { watch, onBeforeUnmount } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { useTabsStore } from "../stores/useTabsStore";
import { canonicalPath, isPathUnder, isSamePath } from "../utils/path";

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
 * - 打开 / 切换工作区时**重新注册**监听（一律先停后启，见 `start()` 的说明）
 * - 关闭工作区时**保留**监听：工作区关了但 tab 还开着，那些文件仍需要外部修改提醒；
 *   那个 watcher 可能已经随目录被删/重建而哑掉，由下次打开时的重新注册兜住（#311）
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
  /**
   * Rust 侧当前已注册监听的路径；`null` = 没有已注册的监听。
   *
   * 关闭工作区后**保持原值**（那个 watcher 并没有被摘掉，见文件头说明），
   * 所以它不总等于当前工作区 —— 判断「该不该重新注册」时不要拿它跟 `workspacePath` 比。
   */
  let registeredPath: string | null = null;

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

  /** 同一路径的多次事件归并：结构变化优先于内容修改（如重命名会伴随 modify）。
   *  键用归一化路径 —— 同一文件的事件写法未必一致，否则会被当成两个文件重复处理。 */
  function mergeChange(change: FileChangePayload): void {
    const key = canonicalPath(change.path);
    const prev = pendingChanges.get(key);
    if (prev && prev.kind !== "modify") return;
    pendingChanges.set(key, change);
  }

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const changes = Array.from(pendingChanges.values());
      pendingChanges.clear();
      for (const change of changes) {
        // 仅处理当前已打开的 tab 对应的文件（按归一化路径比较：事件里的路径写法未必
        // 与打开时一致，字面量比较会漏掉本该处理的改动，见 isSamePath）
        const isOpened = tabsStore.tabs.some(
          (t) => t.path !== null && isSamePath(t.path, change.path)
        );
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

  /** 摘掉已注册的监听（没有则什么都不做） */
  async function unregister(): Promise<void> {
    if (!registeredPath) return;
    await invoke("stop_watching", { path: registeredPath }).catch(() => {});
    registeredPath = null;
  }

  async function start(): Promise<void> {
    // 监听 file-changed 事件
    if (!unlistenFileChanged) {
      // 窗口级 target：Rust 侧用 `emit_to(label)` 定向发送，裸 `listen` 的
      // `Any` target 会匹配一切 emit，导致本窗口收到其它窗口工作区的变更。
      unlistenFileChanged = await getCurrentWebviewWindow().listen<FileChangePayload>("file-changed", (event) => {
        const change = event.payload;
        if (change?.path) {
          mergeChange(change);
          scheduleFlush();
        }
      });
    }

    // 启动工作区监听
    const wsPath = workspace.workspacePath;
    // 工作区被关闭：**有意保留**已有监听 —— 工作区关了但 tab 还开着，那些文件仍需要
    // 「被外部修改 / 删除」的提醒。代价是它可能盯上一个已被外部删掉的目录（哑掉），
    // 这由下面「打开时无条件重新注册」兜住。
    if (!wsPath) return;

    // 打开 / 切换工作区：**无条件先停后启**。
    // 不能拿「路径字符串没变」当作「watcher 还活着」：watcher 盯的是**注册那一刻的目录句柄**，
    // 目录被外部删除 / 重建后它就再也收不到事件，而「关掉工作区再打开同一个文件夹」
    // （或目录被 git clean / 重挂载整体换掉）正好会命中 —— 症状是文件树此后**静默**不再自动刷新
    // （#311：e2e 里 `resetWorkspace` 每轮都删目录重建，于是只有 session 首个工作区能收到事件）。
    await unregister();
    // 停旧监听期间工作区可能又变了：那次变更会触发另一次 start()，本次不该再注册
    // （否则会把 watcher 装到已经作废的路径上，并把 registeredPath 记成错的）
    if (workspace.workspacePath !== wsPath) return;

    try {
      await invoke("start_watching", { path: wsPath });
      registeredPath = wsPath;
    } catch (err) {
      console.error("启动文件监听失败:", err);
    }
  }

  async function stop(): Promise<void> {
    await unregister();
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
