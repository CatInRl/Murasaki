import type { Ref } from "vue";
import { insertTable } from "./useEditorCommands";

/** EditorPane 暴露的接口切片 */
export interface EditorViewLike {
  scrollToLine: (line: number) => void;
  focus: () => void;
  getView: () => unknown;
}

/** useImagePaste 暴露的接口切片 */
export interface ImagePasteLike {
  insertExistingImage: (absolutePath: string) => void;
}

/** useDialogStore 的 prompt 切片 */
export interface DialogPromptLike {
  prompt: (opts: {
    title?: string;
    message: string;
    placeholder?: string;
  }) => Promise<string | null>;
}

/** useEditorNavigation 依赖 */
export interface EditorNavDeps {
  editorRef: Ref<EditorViewLike | null>;
  /** 来自 useFileActions.openFile，用于搜索结果跳转 */
  openFile: (path: string) => Promise<void>;
  imagePaste: ImagePasteLike;
  tableDialogVisible: Ref<boolean>;
  dialog: DialogPromptLike;
}

/**
 * 编辑器内导航/插入操作：跳转、搜索结果打开、图片拖入、右键菜单动作、表格确认。
 *
 * 从 App.vue 提取，保持原有行为不变。
 */
export function useEditorNavigation(deps: EditorNavDeps) {
  const { editorRef, openFile, imagePaste, tableDialogVisible, dialog } = deps;

  function onJumpToLine(line: number): void {
    editorRef.value?.scrollToLine(line);
    editorRef.value?.focus();
  }

  async function onSearchSelectFile(filePath: string, line: number): Promise<void> {
    await openFile(filePath);
    requestAnimationFrame(() => {
      editorRef.value?.scrollToLine(line);
      editorRef.value?.focus();
    });
  }

  function onDropImagePath(absolutePath: string): void {
    imagePaste.insertExistingImage(absolutePath);
  }

  function insertMarkdownAtCursor(text: string): void {
    const view = editorRef.value?.getView() as
      | {
          focus: () => void;
          state: { selection: { main: { from: number; to: number } } };
          dispatch: (spec: {
            changes: { from: number; to: number; insert: string };
            selection: { anchor: number };
            userEvent: string;
          }) => void;
        }
      | null;
    if (!view) return;
    view.focus();
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
      userEvent: "input.insert",
    });
  }

  async function onEditorContextAction(
    action: "insert-table" | "insert-link" | "insert-image"
  ): Promise<void> {
    if (action === "insert-table") {
      tableDialogVisible.value = true;
      return;
    }
    if (action === "insert-link") {
      const url = await dialog.prompt({
        title: "插入链接",
        message: "请输入链接地址：",
        placeholder: "https://example.com",
      });
      if (!url) return;
      const text = await dialog.prompt({
        title: "插入链接",
        message: "请输入链接文字：",
        placeholder: "链接文字",
      });
      insertMarkdownAtCursor(`[${text ?? ""}](${url})`);
      return;
    }
    if (action === "insert-image") {
      const url = await dialog.prompt({
        title: "插入图片",
        message: "请输入图片地址：",
        placeholder: "https://example.com/image.png",
      });
      if (!url) return;
      const alt = await dialog.prompt({
        title: "插入图片",
        message: "请输入替代文字（可选）：",
        placeholder: "替代文字",
      });
      insertMarkdownAtCursor(`![${alt ?? ""}](${url})`);
      return;
    }
  }

  function onTableInsertConfirm(rows: number, cols: number): void {
    tableDialogVisible.value = false;
    const view = editorRef.value?.getView() as
      | {
          focus: () => void;
          state: unknown;
          dispatch: (spec: unknown) => void;
        }
      | null;
    if (view) {
      insertTable(view as never, rows, cols);
      editorRef.value?.focus();
    }
  }

  return {
    onJumpToLine,
    onSearchSelectFile,
    onDropImagePath,
    onEditorContextAction,
    onTableInsertConfirm,
  };
}
