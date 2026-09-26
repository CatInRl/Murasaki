import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { basename } from "../utils/path";
import { MARKDOWN_EXTENSIONS } from "../utils/fileKind";
import { i18n } from "../i18n";
import type { AlertVariant } from "../stores/useDialogStore";

// ===== 依赖类型切片 =====

export interface TabLike {
  id: string;
  path: string | null;
  content: string;
  isDirty: boolean;
}

export interface TabsStoreLike {
  tabs: TabLike[];
  activeTabId: string | null;
  /** 关闭 tab（无未保存修改路径，走 dirty 检查） */
  closeTab: (id: string) => Promise<unknown>;
  /** 强制关闭 tab（跳过 dirty 检查，草稿自动写入） */
  doCloseTab: (id: string) => Promise<unknown>;
  saveTab: (id: string) => Promise<unknown>;
  saveTabAs: (id: string, path: string) => Promise<unknown>;
}

export interface DialogLike {
  unsavedChanges: (options: {
    title?: string;
    message?: string;
    saveText?: string;
    discardText?: string;
    cancelText?: string;
  }) => Promise<"save" | "discard" | "cancel">;
  alert: (options: { message: string; variant?: AlertVariant }) => Promise<void>;
}

export interface WorkspaceLike {
  workspacePath: string | null;
}

export interface TabCloseDeps {
  tabsStore: TabsStoreLike;
  dialog: DialogLike;
  /** 可选，仅用于 saveDialog 的 defaultPath */
  workspace?: WorkspaceLike;
}

/**
 * Tab 关闭逻辑：
 * - 单个关闭：未保存检查（dialog.unsavedChanges）
 * - 批量关闭：无未保存改动时静默关闭；存在未保存改动时只弹**一次**汇总确认
 *
 * 所有对话框均改走 dialog store（unsavedChanges）。
 */
export function useTabClose(deps: TabCloseDeps) {
  const { tabsStore, dialog } = deps;
  const workspace = deps.workspace ?? { workspacePath: null };
  const t = i18n.global.t.bind(i18n.global);

  /**
   * 保存 tab 到磁盘（有路径走 saveTab，无路径走 saveDialog + saveTabAs）。
   * @returns true 表示保存成功可继续关闭，false 表示取消或失败
   */
  async function saveBeforeClose(tabId: string, tab: TabLike): Promise<boolean> {
    if (tab.path) {
      try {
        await tabsStore.saveTab(tabId);
        return true;
      } catch (err) {
        await dialog.alert({ message: t("common.error.saveFailed", { error: err }), variant: "error" });
        return false;
      }
    }
    const selected = await saveDialog({
      filters: [{ name: t("common.fileFilter.markdown"), extensions: MARKDOWN_EXTENSIONS }],
      title: t("common.saveAs"),
      defaultPath: workspace.workspacePath ?? undefined,
    });
    if (typeof selected !== "string" || !selected) return false;
    try {
      await tabsStore.saveTabAs(tabId, selected);
      return true;
    } catch (err) {
      await dialog.alert({ message: t("common.error.saveAsFailed", { error: err }), variant: "error" });
      return false;
    }
  }

  /**
   * 关闭 tab 请求：
   * - 无未保存修改：直接关闭
   * - 有未保存修改：弹出三选一对话框（dialog.unsavedChanges）
   */
  async function onCloseTabRequest(tabId: string): Promise<void> {
    const tab = tabsStore.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    const hasUnsavedChanges = tab.isDirty;
    const fileName = tab.path ? basename(tab.path) : t("common.untitled");

    // 无未保存修改 → 直接关闭
    if (!hasUnsavedChanges) {
      await tabsStore.closeTab(tabId);
      return;
    }

    // 有未保存修改：弹出三选一对话框
    const choice = await dialog.unsavedChanges({
      message: t("common.dialog.unsavedBeforeCloseMessage", { name: fileName }),
    });
    if (choice === "cancel") return;

    if (choice === "save") {
      const ok = await saveBeforeClose(tabId, tab);
      if (!ok) return;
    }
    // discard：跳过 dirty 检查直接关闭（草稿会自动写入）
    await tabsStore.doCloseTab(tabId);
  }

  // ===== 批量关闭（右键菜单触发）=====

  /**
   * 批量关闭：
   * - 待关闭集合内无未保存改动 → 静默关闭（不引入确认噪音）
   * - 存在未保存改动 → 只弹**一次**汇总确认；取消则整批中止，不关闭任何 tab
   * - 选择保存 → 逐个保存（无路径走另存为），任一取消/失败则中止整批
   */
  async function closeMany(ids: string[]): Promise<void> {
    const targets = ids
      .map((id) => tabsStore.tabs.find((t) => t.id === id))
      .filter((tab): tab is TabLike => Boolean(tab));
    if (targets.length === 0) return;

    const dirty = targets.filter((tab) => tab.isDirty);
    if (dirty.length > 0) {
      const names = dirty
        .map((tab) => (tab.path ? basename(tab.path) : t("common.untitled")))
        .join(", ");
      // 未命名 tab 没有草稿兜底，丢弃即永久丢失 → 显式提示
      const base = t("common.dialog.batchCloseMessage", { count: dirty.length, names });
      const message = dirty.some((tab) => !tab.path)
        ? `${base}\n\n${t("common.dialog.batchCloseUntitledWarning")}`
        : base;

      const choice = await dialog.unsavedChanges({
        title: t("common.dialog.batchCloseTitle"),
        message,
        saveText: t("common.saveAllAndClose"),
        discardText: t("common.closeWithoutSaving"),
        cancelText: t("common.cancel"),
      });
      if (choice === "cancel") return;

      if (choice === "save") {
        for (const tab of dirty) {
          const ok = await saveBeforeClose(tab.id, tab);
          if (!ok) return;
        }
      }
    }

    for (const tab of targets) {
      await tabsStore.doCloseTab(tab.id);
    }
  }

  async function onCloseOthers(tabId: string): Promise<void> {
    await closeMany(tabsStore.tabs.filter((t) => t.id !== tabId).map((t) => t.id));
  }

  async function onCloseRight(tabId: string): Promise<void> {
    const idx = tabsStore.tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    await closeMany(tabsStore.tabs.filter((_, i) => i > idx).map((t) => t.id));
  }

  async function onCloseLeft(tabId: string): Promise<void> {
    const idx = tabsStore.tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    await closeMany(tabsStore.tabs.filter((_, i) => i < idx).map((t) => t.id));
  }

  async function onCloseAllTabs(): Promise<void> {
    await closeMany(tabsStore.tabs.map((t) => t.id));
  }

  return {
    onCloseTabRequest,
    onCloseOthers,
    onCloseRight,
    onCloseLeft,
    onCloseAllTabs,
  };
}
