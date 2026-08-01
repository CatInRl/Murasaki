import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { basename } from "../utils/path";
import { i18n } from "../i18n";

/** useTabsStore 的接口切片 */
export interface TabsStoreLike {
  getTabByPath: (path: string) => { id: string; path: string | null; content: string; isDirty: boolean } | null;
  reloadFromDisk: (path: string) => Promise<unknown>;
  applyExternalResolution: (path: string, mode: "load-disk" | "keep-local", content?: string) => Promise<unknown>;
  markExternalChange: (path: string, marked: boolean) => void;
  writeMergedContent: (filePath: string, mergedContent: string) => Promise<unknown>;
}

export interface DialogLike {
  alert: (opts: { message: string; variant?: "info" | "warning" | "error" }) => void;
  unsavedChanges: (options: {
    title?: string;
    message?: string;
    saveText?: string;
    discardText?: string;
    cancelText?: string;
  }) => Promise<"save" | "discard" | "cancel">;
}

export interface CompareState {
  visible: boolean;
  filePath: string;
  externalContent: string;
  localContent: string;
}

/** useCompareWindow 依赖 */
export interface CompareWindowDeps {
  tabsStore: TabsStoreLike;
  dialog: DialogLike;
}

/**
 * 对比窗口 + 外部修改处理：external-change 事件 → 三选一对话框 → 对比窗口编排。
 *
 * 三选一对话框改走 dialog store（unsavedChanges），不再使用 App.vue 内联 NModal。
 * compareState 由本 composable 持有，模板直接绑定。
 */
export function useCompareWindow(deps: CompareWindowDeps) {
  const { tabsStore, dialog } = deps;
  const t = i18n.global.t.bind(i18n.global);

  const compareState = ref<CompareState>({
    visible: false,
    filePath: "",
    externalContent: "",
    localContent: "",
  });

  /** 外部修改事件处理：自动重载或弹三选一 */
  async function handleExternalChange(path: string): Promise<void> {
    const tab = tabsStore.getTabByPath(path);
    if (!tab) return;
    const mtime = await invoke<number>("get_file_mtime", { path }).catch(() => null);
    if (mtime === null) {
      tabsStore.markExternalChange(path, true);
      if (!tab.isDirty) {
        dialog.alert({ message: t("common.dialog.fileDeletedExternal", { path }), variant: "warning" });
      } else {
        dialog.alert({ message: t("common.dialog.fileDeletedExternalDraftKept", { path }), variant: "warning" });
      }
      return;
    }
    if (!tab.isDirty) {
      await tabsStore.reloadFromDisk(path);
      return;
    }
    const externalContent = await invoke<string>("read_text_file", { path });
    const fileName = basename(path);
    // 三选一对话框改走 dialog store（unsavedChanges）
    // 映射：save → 加载磁盘版本 / discard → 保留本地版本 / cancel → 对比并合并
    const choice = await dialog.unsavedChanges({
      title: t("common.dialog.fileModifiedExternalTitle"),
      message: t("common.dialog.fileModifiedExternalMessage", { name: fileName }),
      saveText: t("common.loadDiskVersion"),
      discardText: t("common.keepLocalVersion"),
      cancelText: t("common.compareAndMerge"),
    });
    if (choice === "save") {
      await tabsStore.applyExternalResolution(path, "load-disk", externalContent);
    } else if (choice === "discard") {
      await tabsStore.applyExternalResolution(path, "keep-local");
    } else {
      // cancel → compare
      compareState.value = {
        visible: true,
        filePath: path,
        externalContent,
        localContent: tab.content,
      };
    }
  }

  async function onCompareSave(mergedContent: string): Promise<void> {
    const { filePath } = compareState.value;
    try {
      await tabsStore.writeMergedContent(filePath, mergedContent);
    } catch (err) {
      console.error("保存合并结果失败:", err);
      dialog.alert({ message: t("common.error.saveMergeFailed", { error: err }), variant: "error" });
    }
    compareState.value = { ...compareState.value, visible: false };
  }

  async function onCompareUseExternal(externalContent: string): Promise<void> {
    const { filePath } = compareState.value;
    await tabsStore.applyExternalResolution(filePath, "load-disk", externalContent);
    compareState.value = { ...compareState.value, visible: false };
  }

  function onCompareClose(): void {
    const { filePath } = compareState.value;
    tabsStore.markExternalChange(filePath, true);
    compareState.value = { ...compareState.value, visible: false };
  }

  return {
    compareState,
    handleExternalChange,
    onCompareSave,
    onCompareUseExternal,
    onCompareClose,
  };
}
