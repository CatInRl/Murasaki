/**
 * 编辑器测试工具函数
 *
 * 从 useEditorCommands.ts 提取的测试专用 helper，集中管理避免污染生产模块接口。
 * 供单元测试（useEditorCommands.test.ts / enter-blockquote.test.ts 等）使用。
 */
import type { Extension } from "@codemirror/state";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

/**
 * 从字符串创建 EditorView（附加到 jsdom DOM）
 */
export function createTestView(doc: string, extensions: Extension[] = []): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [keymap.of([]), ...extensions],
    }),
    parent: host,
  });
}

/**
 * 在指定位置设置选区
 */
export function setSelection(view: EditorView, anchor: number, head?: number): void {
  view.dispatch({
    selection: { anchor, head: head ?? anchor },
  });
}

/**
 * 获取当前文档内容
 */
export function getDoc(view: EditorView): string {
  return view.state.doc.toString();
}
