/**
 * 原生拖放打开 composable（issue #92）
 *
 * 监听 Tauri 原生 drag-drop 事件（`getCurrentWebviewWindow().onDragDropEvent`），
 * 把从系统拖入窗口的文件/文件夹路径交给 Rust `classify_drop_paths` 分类，
 * 再由 `planDrop` 规划动作：单个目录 → 走「打开文件夹」同一路径（同目录已开则聚焦
 * 那个窗口，否则新窗口）；文件 → **在当前窗口**逐个开标签（与 `Ctrl+O` / 最近文件一致）；
 * 图片 → **在当前窗口**按插入方式插入编辑器（issue #288）；应用打不开的文件 →
 * 一次提示（恰好 1 个时附「用系统默认程序打开」动作，issue #317）；多投时被忽略的目录 →
 * 一次提示（issue #318）。
 *
 * 机制说明：Tauri 的 `dragDropEnabled`（默认 true）会让 WebView2 拦截系统文件拖放，
 * 改以 `tauri://drag-enter|over|drop|leave` 事件告之——HTML5 的 `drop` 因此收不到系统
 * 文件拖放，故图片也走这条原生链路（`useImagePaste` 不再监听 HTML5 `drop`）。
 */
import { ref, type Ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { planDrop, type DropEntry, type DropPlan } from "../utils/dropPlan";
import type { PhysicalPoint } from "../utils/dropPosition";

export interface UseDragDropOptions {
  /** 打开文件为标签（当前窗口） */
  openFile: (path: string) => Promise<void> | void;
  /**
   * 把目录作为工作区打开。
   * 具体落在哪个窗口由实现方决定：同目录已在某窗口打开则聚焦那个窗口，否则新开窗口
   * （与「打开文件夹」入口共用同一路径，见 ADR-0018）。
   */
  openFolder: (path: string) => Promise<void> | void;
  /**
   * 把外部拖入的图片插入当前窗口的编辑器（issue #288）：
   * `position` 是 Tauri 给的物理像素落点（可空，取不到则落到光标处）。
   */
  insertImages: (paths: string[], position: PhysicalPoint | null) => Promise<void> | void;
  /**
   * 拖入的条目里有「应用打不开的文件」时调用一次（issue #317）：
   * 恰好 1 个 → 实现方应附上「用系统默认程序打开」动作；≥2 个 → 只报计数。
   * 缺失路径与多投时被忽略的目录**不会**进这里。
   */
  notifyUnsupportedFiles: (paths: string[]) => void;
  /**
   * 拖入的条目里有「被忽略的目录」时调用一次（issue #318）：多个目录，或目录与文件混投时，
   * 目录既不会成为工作区（一个窗口只能有一个工作区，见 ADR-0018）、也不会被打开，
   * 实现方应告知用户一句（纯提示，不给动作 —— 「打开哪个」没有自然答案）。
   * 单个目录被用作工作区时**不会**进这里；缺失路径也不会。
   */
  notifyIgnoredFolders: (paths: string[]) => void;
}

export interface UseDragDrop {
  /** 是否有文件正拖到窗口上（驱动遮罩显示） */
  dragging: Ref<boolean>;
  /** 注册原生 drag-drop 监听（onMounted 中调用） */
  setup(): Promise<void>;
  /** 移除监听（onBeforeUnmount 中调用） */
  teardown(): void;
}

export function useDragDrop(options: UseDragDropOptions): UseDragDrop {
  const dragging = ref(false);
  let unlisten: (() => void) | null = null;

  async function handleDropPaths(
    paths: string[],
    position: PhysicalPoint | null
  ): Promise<DropPlan> {
    const entries = await invoke<DropEntry[]>("classify_drop_paths", { paths });
    const plan = planDrop(entries);

    if (plan.workspace) {
      await options.openFolder(plan.workspace);
    } else {
      // 逐个打开，保持拖入顺序
      for (const path of plan.files) {
        await options.openFile(path);
      }
    }
    // 图片在当前窗口插入编辑器（不打开标签、不设工作区）；无编辑器时实现方自行忽略
    if (plan.images.length > 0) {
      await options.insertImages(plan.images, position);
    }
    // 打不开的文件：不静默丢弃，交给实现方提示（issue #317）
    if (plan.unsupportedFiles.length > 0) {
      options.notifyUnsupportedFiles(plan.unsupportedFiles);
    }
    // 被忽略的目录：一个窗口只能有一个工作区，忽略是必然，但要说一句（issue #318）
    if (plan.ignoredFolders.length > 0) {
      options.notifyIgnoredFolders(plan.ignoredFolders);
    }
    return plan;
  }

  async function setup(): Promise<void> {
    unlisten = await getCurrentWebviewWindow().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter" || payload.type === "over") {
        dragging.value = true;
      } else if (payload.type === "leave") {
        dragging.value = false;
      } else if (payload.type === "drop") {
        dragging.value = false;
        void handleDropPaths(payload.paths, payload.position).catch((err) => {
          console.error("处理拖放路径失败:", err);
        });
      }
    });
  }

  function teardown(): void {
    unlisten?.();
    unlisten = null;
    dragging.value = false;
  }

  return { dragging, setup, teardown };
}
