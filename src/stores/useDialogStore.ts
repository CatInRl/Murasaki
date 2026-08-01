import { defineStore } from "pinia";
import { ref, computed, reactive } from "vue";
import { i18n } from "../i18n";

/**
 * 对话框 Store（Ticket #66 / T2.2）
 *
 * 全局 Pinia store + Promise/数据驱动 API，替换全仓 35 处原生
 * alert()/confirm()/prompt()。4 类型：alert / confirm / prompt / conflict。
 *
 * T8.3（Ticket #80）新增第 5 类 unsaved：三按钮（取消 / 不保存 / 保存），
 * 用于设置窗口关闭未保存确认。
 *
 * 模态栈：同时只显示一个对话框，新对话框入队等待，当前对话框 resolve 后
 * 自动显示下一个。
 *
 * Escape 键等同取消（由 DialogContainer.vue 触发 cancelCurrent）。
 */

// ===== 类型定义 =====

export type AlertVariant = "info" | "warning" | "error";

export interface AlertDialogOptions {
  title?: string;
  message: string;
  variant?: AlertVariant;
  /** 确认按钮文本，默认 "确定" */
  confirmText?: string;
}

export interface ConfirmDialogOptions {
  title?: string;
  message: string;
  /** 危险变体：确认按钮变红 */
  danger?: boolean;
  confirmText?: string;
  cancelText?: string;
}

export interface PromptDialogOptions {
  title?: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  /** 校验函数：返回错误信息字符串（无效）或 null（有效） */
  validate?: (value: string) => string | null;
  confirmText?: string;
  cancelText?: string;
}

export interface ConflictDialogOptions {
  /** 冲突目标文件名 */
  filename: string;
  /** 源文件路径（可选，用于显示） */
  sourcePath?: string;
  /** 触发冲突的操作类型 */
  operation?: "rename" | "copy" | "save-as";
  title?: string;
}

export interface ConflictDialogResult {
  action: "overwrite" | "rename" | "cancel";
  newName?: string;
}

/** T8.3：未保存改动确认对话框选项 */
export interface UnsavedChangesDialogOptions {
  title?: string;
  message?: string;
  /** 保存按钮文本，默认 "保存" */
  saveText?: string;
  /** 不保存按钮文本，默认 "不保存" */
  discardText?: string;
  /** 取消按钮文本，默认 "取消" */
  cancelText?: string;
}

/** T8.3：未保存改动确认对话框结果 */
export type UnsavedChangesResult = "save" | "discard" | "cancel";

// ===== 内部状态类型 =====

type DialogKind = "alert" | "confirm" | "prompt" | "conflict" | "unsaved";

interface DialogState {
  id: number;
  kind: DialogKind;
  title: string;
  message: string;
  /** alert 变体 */
  variant: AlertVariant;
  /** 按钮文本 */
  confirmText: string;
  cancelText: string;
  /** unsaved：中间按钮（不保存）文本 */
  neutralText: string;
  /** confirm 危险变体 */
  danger: boolean;
  /** prompt 输入相关 */
  placeholder: string;
  inputValue: string;
  validate?: (value: string) => string | null;
  validationError: string | null;
  /** conflict 相关 */
  filename: string;
  sourcePath: string;
  operation: "rename" | "copy" | "save-as";
  /** conflict 两步流程：是否已展开重命名输入框 */
  showRenameInput: boolean;
  /** Promise resolver */
  resolver: (value: unknown) => void;
}

export const useDialogStore = defineStore("dialog", () => {
  // ===== State =====
  /** 模态栈：queue[0] 为当前显示的对话框 */
  const queue = ref<DialogState[]>([]);

  // i18n 全局翻译函数（store 在组件外使用，需走全局实例）
  const t = i18n.global.t.bind(i18n.global);

  // ===== Getters =====
  /** 当前显示的对话框（同时只显示一个） */
  const current = computed<DialogState | null>(() => queue.value[0] ?? null);

  /** 是否有对话框打开 */
  const isOpen = computed(() => queue.value.length > 0);

  // ===== 内部方法 =====
  let nextId = 1;

  function enqueue(state: Omit<DialogState, "id">): DialogState {
    const item = reactive({ ...state, id: nextId++ }) as DialogState;
    queue.value.push(item);
    return item;
  }

  /** resolve 当前对话框并从队列移除 */
  function resolveCurrent(value: unknown): void {
    const item = queue.value.shift();
    if (item) {
      item.resolver(value);
    }
  }

  // ===== Public API：5 类对话框 =====

  /** alert：单按钮，info/warning/error 变体 */
  function alert(options: AlertDialogOptions): Promise<void> {
    const variant = options.variant ?? "info";
    return new Promise<void>((resolve) => {
      enqueue({
        kind: "alert",
        title: options.title ?? defaultTitleForVariant(variant),
        message: options.message,
        variant,
        confirmText: options.confirmText ?? t("common.ok"),
        cancelText: "",
        neutralText: "",
        danger: false,
        placeholder: "",
        inputValue: "",
        validationError: null,
        filename: "",
        sourcePath: "",
        operation: "rename",
        showRenameInput: false,
        resolver: () => resolve(),
      });
    });
  }

  /** confirm：双按钮，可选 danger 红色确认按钮。返回 boolean */
  function confirm(options: ConfirmDialogOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      enqueue({
        kind: "confirm",
        title: options.title ?? t("common.dialog.confirmTitle"),
        message: options.message,
        variant: "info",
        confirmText: options.confirmText ?? t("common.ok"),
        cancelText: options.cancelText ?? t("common.cancel"),
        neutralText: "",
        danger: options.danger ?? false,
        placeholder: "",
        inputValue: "",
        validationError: null,
        filename: "",
        sourcePath: "",
        operation: "rename",
        showRenameInput: false,
        resolver: (v: unknown) => resolve(v as boolean),
      });
    });
  }

  /** prompt：双按钮 + 输入框。返回 string（确认）或 null（取消） */
  function prompt(options: PromptDialogOptions): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      enqueue({
        kind: "prompt",
        title: options.title ?? t("common.dialog.promptTitle"),
        message: options.message ?? "",
        variant: "info",
        confirmText: options.confirmText ?? t("common.ok"),
        cancelText: options.cancelText ?? t("common.cancel"),
        neutralText: "",
        danger: false,
        placeholder: options.placeholder ?? "",
        inputValue: options.defaultValue ?? "",
        validate: options.validate,
        validationError: null,
        filename: "",
        sourcePath: "",
        operation: "rename",
        showRenameInput: false,
        resolver: (v: unknown) => resolve(v as string | null),
      });
    });
  }

  /** conflict：三按钮（取消/重命名/覆盖）。返回 { action, newName? } */
  function conflict(options: ConflictDialogOptions): Promise<ConflictDialogResult> {
    return new Promise<ConflictDialogResult>((resolve) => {
      enqueue({
        kind: "conflict",
        title: options.title ?? defaultConflictTitle(options.operation),
        message: t("common.dialog.conflictMessage", { filename: options.filename }),
        variant: "warning",
        confirmText: t("common.overwrite"),
        cancelText: t("common.cancel"),
        neutralText: "",
        danger: true,
        placeholder: t("common.dialog.conflictRenamePlaceholder"),
        inputValue: options.filename,
        validationError: null,
        filename: options.filename,
        sourcePath: options.sourcePath ?? "",
        operation: options.operation ?? "rename",
        showRenameInput: false,
        resolver: (v: unknown) => resolve(v as ConflictDialogResult),
      });
    });
  }

  /**
   * unsaved：三按钮（取消 / 不保存 / 保存）。返回 "save" | "discard" | "cancel"
   * 用于设置窗口关闭未保存确认（Ticket #80 / T8.3）。
   * 按钮顺序：取消（左） / 不保存（中） / 保存（右，primary）
   */
  function unsavedChanges(
    options: UnsavedChangesDialogOptions
  ): Promise<UnsavedChangesResult> {
    return new Promise<UnsavedChangesResult>((resolve) => {
      enqueue({
        kind: "unsaved",
        title: options.title ?? t("common.dialog.unsavedTitle"),
        message: options.message ?? t("common.dialog.unsavedMessage"),
        variant: "warning",
        confirmText: options.saveText ?? t("common.save"),
        cancelText: options.cancelText ?? t("common.cancel"),
        neutralText: options.discardText ?? t("common.discard"),
        danger: false,
        placeholder: "",
        inputValue: "",
        validationError: null,
        filename: "",
        sourcePath: "",
        operation: "rename",
        showRenameInput: false,
        resolver: (v: unknown) => resolve(v as UnsavedChangesResult),
      });
    });
  }

  // ===== 由 DialogContainer 调用的操作 =====

  /** 取消当前对话框（Escape / 点击遮罩 / 点击取消按钮） */
  function cancelCurrent(): void {
    const item = current.value;
    if (!item) return;
    switch (item.kind) {
      case "alert":
        resolveCurrent(undefined);
        break;
      case "confirm":
        resolveCurrent(false);
        break;
      case "prompt":
        resolveCurrent(null);
        break;
      case "conflict":
        resolveCurrent({ action: "cancel" });
        break;
      case "unsaved":
        resolveCurrent("cancel");
        break;
    }
  }

  /** alert/confirm 的确认按钮 */
  function confirmCurrent(): void {
    const item = current.value;
    if (!item) return;
    if (item.kind === "alert") {
      resolveCurrent(undefined);
    } else if (item.kind === "confirm") {
      resolveCurrent(true);
    }
  }

  /** prompt 提交输入。校验失败时设置 validationError，不 resolve */
  function submitPrompt(): void {
    const item = current.value;
    if (!item || item.kind !== "prompt") return;
    const value = item.inputValue;
    if (item.validate) {
      const err = item.validate(value);
      if (err) {
        item.validationError = err;
        return;
      }
    }
    item.validationError = null;
    resolveCurrent(value);
  }

  /** 更新 prompt 输入值（双向绑定用），清除校验错误 */
  function updatePromptInput(value: string): void {
    const item = current.value;
    if (!item || item.kind !== "prompt") return;
    item.inputValue = value;
    if (item.validationError) {
      item.validationError = null;
    }
  }

  /** conflict：覆盖 */
  function conflictOverwrite(): void {
    resolveCurrent({ action: "overwrite" });
  }

  /** conflict：重命名（两步流程） */
  function conflictRename(): void {
    const item = current.value;
    if (!item || item.kind !== "conflict") return;
    if (item.showRenameInput) {
      const newName = item.inputValue.trim();
      if (!newName) return;
      if (newName === item.filename) {
        item.validationError = t("common.dialog.conflictSameNameError");
        return;
      }
      resolveCurrent({ action: "rename", newName });
    } else {
      item.showRenameInput = true;
      item.inputValue = item.filename;
    }
  }

  /** 更新 conflict 重命名输入值 */
  function updateConflictRenameInput(value: string): void {
    const item = current.value;
    if (!item || item.kind !== "conflict") return;
    item.inputValue = value;
    if (item.validationError) {
      item.validationError = null;
    }
  }

  /** unsaved：保存（resolve "save"） */
  function unsavedSave(): void {
    resolveCurrent("save");
  }

  /** unsaved：不保存（resolve "discard"） */
  function unsavedDiscard(): void {
    resolveCurrent("discard");
  }

  // ===== 工具函数 =====
  function defaultTitleForVariant(variant: AlertVariant): string {
    switch (variant) {
      case "warning":
        return t("common.dialog.warningTitle");
      case "error":
        return t("common.dialog.errorTitle");
      default:
        return t("common.dialog.infoTitle");
    }
  }

  function defaultConflictTitle(operation?: "rename" | "copy" | "save-as"): string {
    switch (operation) {
      case "rename":
        return t("common.dialog.conflictRenameTitle");
      case "copy":
        return t("common.dialog.conflictCopyTitle");
      case "save-as":
        return t("common.dialog.conflictSaveAsTitle");
      default:
        return t("common.dialog.conflictTitle");
    }
  }

  return {
    // state
    queue,
    // getters
    current,
    isOpen,
    // public API
    alert,
    confirm,
    prompt,
    conflict,
    unsavedChanges,
    // container actions
    cancelCurrent,
    confirmCurrent,
    submitPrompt,
    updatePromptInput,
    conflictOverwrite,
    conflictRename,
    updateConflictRenameInput,
    unsavedSave,
    unsavedDiscard,
  };
});