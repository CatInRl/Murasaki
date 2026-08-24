import { ref } from "vue";
import { check as checkForUpdate, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * 可序列化的更新信息（从 plugin 的 Update 对象提取，供 UI 使用）。
 * Update 对象本身含方法（downloadAndInstall/close），不可直接放入响应式状态。
 */
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
}

/** useUpdater 依赖的 toast 切片 */
export interface UpdaterToast {
  success(title: string): unknown;
  info(title: string): unknown;
  error(title: string): unknown;
  /** 显示 indeterminate 进度 toast（duration=0 表示不自动消失），返回 toast id */
  progress(title: string, opts?: { duration?: number; progress?: number }): string;
  /** 更新已有 toast 的标题 / 进度 / duration */
  update(
    id: string,
    patch: { title?: string; progress?: number; duration?: number }
  ): void;
  /** 关闭指定 toast */
  dismiss(id: string): void;
}

export interface UpdaterDeps {
  toast: UpdaterToast;
  /**
   * 非静默模式下检测到可用更新时调用（典型用法：打开 UpdateDialog）。
   * 静默模式（silent=true）不触发此回调，由调用方自行决定如何提示。
   */
  onUpdateAvailable?: (update: UpdateInfo) => void;
}

/**
 * Tauri updater 封装（ADR-0012）
 *
 * - check(silent) 检查更新，silent=true 时不弹任何 UI/toast（启动时静默检查用）
 * - downloadAndInstall(update) 下载 + 安装 + 自动重启（indeterminate 进度 toast）
 * - restart() 单独重启（用于「稍后重启」场景）
 *
 * 内部维护非响应式的 pendingUpdate（plugin 的 Update 对象），
 * check 时缓存，downloadAndInstall 时消费。
 */
export function useUpdater(deps: UpdaterDeps) {
  const { toast, onUpdateAvailable } = deps;

  const checking = ref(false);
  const downloading = ref(false);
  const availableUpdate = ref<UpdateInfo | null>(null);

  /** 最近一次 check 返回的 plugin Update 对象（非响应式，含方法） */
  let pendingUpdate: Update | null = null;

  /**
   * 检查更新。
   * @param silent true 时不显示任何 toast / 不触发回调（启动静默检查用）
   * @returns UpdateInfo 或 null（无更新 / 失败 / 正在检查）
   */
  async function check(silent = false): Promise<UpdateInfo | null> {
    if (checking.value) return null;
    checking.value = true;
    try {
      const update = await checkForUpdate();
      if (update) {
        pendingUpdate = update;
        const info: UpdateInfo = {
          version: update.version,
          currentVersion: update.currentVersion,
          date: update.date,
          body: update.body,
        };
        availableUpdate.value = info;
        if (!silent) {
          onUpdateAvailable?.(info);
        }
        return info;
      }
      // 无更新
      pendingUpdate = null;
      availableUpdate.value = null;
      if (!silent) {
        toast.success("已是最新版本");
      }
      return null;
    } catch (err) {
      if (!silent) {
        toast.error(`检查更新失败: ${err}`);
      }
      return null;
    } finally {
      checking.value = false;
    }
  }

  /**
   * 下载 + 安装 + 自动重启。
   * 使用 check() 时缓存的 pendingUpdate（plugin 的 Update 对象）。
   * @param update 调用方传入的 UpdateInfo（用于校验一致性，实际操作走 pendingUpdate）
   */
  async function downloadAndInstall(update: UpdateInfo): Promise<void> {
    if (downloading.value) return;
    if (!pendingUpdate) {
      toast.error("无可安装的更新，请重新检查");
      return;
    }
    // 一致性校验：调用方传入的版本应与缓存的一致
    if (update.version !== pendingUpdate.version) {
      toast.error("更新信息已过期，请重新检查");
      return;
    }
    downloading.value = true;
    // 先显示无进度的 toast（indeterminate）：duration=0 不自动消失，无 progress 值
    const toastId = toast.progress("正在下载更新…", { duration: 0 });
    // 累计已下载字节与总字节，用于把真实进度写回 toast
    let downloaded = 0;
    let total: number | undefined;
    try {
      await pendingUpdate.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength != null) {
          total = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          const pct = total && total > 0
            ? Math.min(100, Math.round((downloaded / total) * 100))
            : 0;
          toast.update(toastId, {
            title: total ? `正在下载更新… ${pct}%` : "正在下载更新…",
            progress: total ? pct : undefined,
          });
        }
      });
      toast.dismiss(toastId);
      toast.success("更新已安装，即将重启…");
      await relaunch();
    } catch (err) {
      toast.dismiss(toastId);
      toast.error(`下载更新失败: ${err}`);
    } finally {
      downloading.value = false;
    }
  }

  /** 单独重启（用于「稍后重启」按钮） */
  async function restart(): Promise<void> {
    try {
      await relaunch();
    } catch (err) {
      toast.error(`重启失败: ${err}`);
    }
  }

  return {
    checking,
    downloading,
    availableUpdate,
    check,
    downloadAndInstall,
    restart,
  };
}
