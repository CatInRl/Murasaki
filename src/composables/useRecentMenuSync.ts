import { watch, type Ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { RecentEntry } from "../types";

/** useRecentMenuSync 依赖的持久化切片 */
export interface PersistenceLike {
  recentEntries: Ref<RecentEntry[]>;
  getRecentFolders: (limit?: number) => RecentEntry[];
  getRecentFiles: (limit?: number) => RecentEntry[];
}

/**
 * 最近打开菜单同步：将 persistence.recentEntries 同步到 OS 原生菜单的"最近打开"子菜单。
 *
 * - watcher 监听 recentEntries 变化，debounce 150ms 合并短时间连续变更
 * - in-flight 锁防止并发 invoke，期间若再触发则标记重排（取最新状态）
 * - initialized=false 时 watcher 不触发 sync（应用启动完成前的变更由初始 syncNow 处理）
 *
 * 调用方在 setup 中调用一次；返回 syncNow 供初始同步使用。
 */
export function useRecentMenuSync(options: {
  persistence: PersistenceLike;
  initialized: Ref<boolean>;
}): {
  syncNow: () => Promise<void>;
} {
  const { persistence, initialized } = options;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let scheduled = false;

  /** 同步到原生菜单：in-flight 锁 + 重排循环 */
  async function sync(): Promise<void> {
    if (inFlight) {
      scheduled = true;
      return;
    }
    inFlight = true;
    try {
      do {
        scheduled = false;
        const folders = persistence.getRecentFolders(5).map((e) => e.path);
        const files = persistence.getRecentFiles(5).map((e) => e.path);
        try {
          await invoke("update_recent_menu", { folders, files });
        } catch (err) {
          console.warn("更新最近打开菜单失败:", err);
          return;
        }
      } while (scheduled);
    } finally {
      inFlight = false;
    }
  }

  /** debounced 版本：合并短时间内连续的 recentEntries 变化 */
  function scheduleSync(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (initialized.value) void sync();
    }, 150);
  }

  watch(() => persistence.recentEntries.value, scheduleSync, { deep: true });

  return { syncNow: sync };
}
