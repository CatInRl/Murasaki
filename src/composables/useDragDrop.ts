/**
 * 原生拖放打开 composable（issue #92）
 *
 * 监听 Tauri 原生 drag-drop 事件（`getCurrentWebviewWindow().onDragDropEvent`），
 * 把从系统拖入窗口的文件/文件夹路径交给 Rust `classify_drop_paths` 分类，
 * 再由 `planDrop` 规划动作：单个目录 → 本窗口工作区；文件 → 逐个开标签。
 *
 * 机制说明：Tauri 的 `dragDropEnabled`（默认 true）会让 WebView2 拦截系统文件拖放，
 * 改以 `tauri://drag-enter|over|drop|leave` 事件告之——HTML5 的 `drop` 因此收不到系统
 * 文件拖放（图片链路的修复见 #288，本 PR 不碰 `useImagePaste.ts`）。
 *
 * 图片与不受支持的类型本 PR **不处理**（图片链路见 #288）：`planDrop` 已把它们排除在
 * `plan.files` 之外（图片进 `plan.images`、其余进 `plan.skipped`），这里只跑 `plan.files`。
 */
import { ref, type Ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { planDrop, type DropEntry, type DropPlan } from "../utils/dropPlan";

export interface UseDragDropOptions {
  /** 打开文件为标签（当前窗口） */
  openFile: (path: string) => Promise<void> | void;
  /** 打开目录为本窗口工作区 */
  openWorkspace: (path: string) => Promise<void> | void;
}

export interface UseDragDrop {
  /** 是否有文件正拖到窗口上（驱动遮罩显示） */
  dragging: Ref<boolean>;
  /** 注册原生 drag-drop 监听（onMounted 中调用） */
  setup(): Promise<void>;
  /** 移除监听（onBeforeUnmount 中调用） */
  teardown(): void;
  /** 分类并执行一次拖放，返回规划结果（供 e2e / 直接调用） */
  handleDropPaths(paths: string[]): Promise<DropPlan>;
}

export function useDragDrop(options: UseDragDropOptions): UseDragDrop {
  const dragging = ref(false);
  let unlisten: (() => void) | null = null;

  async function handleDropPaths(paths: string[]): Promise<DropPlan> {
    const entries = await invoke<DropEntry[]>("classify_drop_paths", { paths });
    const plan = planDrop(entries);

    if (plan.workspace) {
      await options.openWorkspace(plan.workspace);
      return plan;
    }
    // 逐个打开，保持拖入顺序；图片 / 缺失路径本 PR 忽略（图片见 #288）
    for (const path of plan.files) {
      await options.openFile(path);
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
        void handleDropPaths(payload.paths).catch((err) => {
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

  return { dragging, setup, teardown, handleDropPaths };
}
