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

export interface AgentStoreLike {
  isThinking: boolean;
  cancel: () => void;
}

export interface DialogLike {
  unsavedChanges: (options: {
    title?: string;
    message?: string;
    saveText?: string;
    discardText?: string;
    cancelText?: string;
  }) => Promise<"save" | "discard" | "cancel">;
  confirm: (options: {
    title?: string;
    message: string;
    danger?: boolean;
    confirmText?: string;
    cancelText?: string;
  }) => Promise<boolean>;
  alert: (options: { message: string; variant?: AlertVariant }) => Promise<void>;
}

export interface WorkspaceLike {
  workspacePath: string | null;
}

export interface TabCloseDeps {
  tabsStore: TabsStoreLike;
  agentStore: AgentStoreLike;
  dialog: DialogLike;
  /** 可选，仅用于 saveDialog 的 defaultPath */
  workspace?: WorkspaceLike;
}

/**
 * Tab 关闭逻辑：
 * - 单个关闭：未保存检查 / agent 运行中合并对话框（Ticket #24c）
 * - 批量关闭：无未保存改动时静默关闭；存在未保存改动时只弹**一次**汇总确认
 *
 * 所有对话框均改走 dialog store（unsavedChanges / confirm）。
 */
export function useTabClose(deps: TabCloseDeps) {
  const { tabsStore, agentStore, dialog } = deps;
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
   * - Agent 运行中 + 关闭活动 tab：弹出合并/简单对话框
   *   - 有未保存修改（merged）：unsavedChanges → cancel / close without saving / save and close
   *   - 无未保存修改（simple）：confirm → cancel / force close
   *   - 选择关闭时先 cancel agent（保留部分回答到对话历史）
   * - 否则走原有的未保存修改检查（dialog.unsavedChanges）
   */
  async function onCloseTabRequest(tabId: string): Promise<void> {
    const tab = tabsStore.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    const isActiveTab = tabsStore.activeTabId === tabId;
    const agentRunning = agentStore.isThinking && isActiveTab;
    const hasUnsavedChanges = tab.isDirty;
    const fileName = tab.path ? basename(tab.path) : t("common.untitled");

    // Case 1: Agent 运行中 + 关闭活动 tab + 有未保存修改 → 合并对话框（3 选项）
    if (agentRunning && hasUnsavedChanges) {
      const choice = await dialog.unsavedChanges({
        title: t("common.dialog.agentRunningUnsavedTitle"),
        message: t("common.dialog.agentRunningUnsavedMessage", { name: fileName }),
        saveText: t("common.saveAndClose"),
        discardText: t("common.closeWithoutSaving"),
        cancelText: t("common.cancel"),
      });
      if (choice === "cancel") return;

      // 中断 agent（cancel() 会保留部分回答到对话历史）
      agentStore.cancel();

      if (choice === "save") {
        const ok = await saveBeforeClose(tabId, tab);
        if (!ok) return;
      }
      // discard（不保存）：跳过 dirty 检查直接关闭（草稿会自动写入）
      await tabsStore.doCloseTab(tabId);
      return;
    }

    // Case 2: Agent 运行中 + 关闭活动 tab + 无未保存修改 → 简单确认（2 选项）
    if (agentRunning) {
      const shouldClose = await dialog.confirm({
        title: t("common.dialog.agentRunningTitle"),
        message: t("common.dialog.agentRunningMessage", { name: fileName }),
        danger: true,
        confirmText: t("common.forceClose"),
        cancelText: t("common.cancel"),
      });
      if (!shouldClose) return;

      agentStore.cancel();
      await tabsStore.doCloseTab(tabId);
      return;
    }

    // Case 3: 无 agent 运行 → 原有 dirty 检查
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
