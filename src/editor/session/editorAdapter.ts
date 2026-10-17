/**
 * EditorAdapter 的 CodeMirror 实现。
 *
 * 这个 adapter 存在的意义：把「换文档状态后必须重新应用哪些配置」这条顺序约束
 * 收在一处。宿主只需提供视图、选择监听用的 compartment 与「应用某个模式」的回调。
 */
import type { Compartment, Extension } from "@codemirror/state";
import { EditorState, Transaction } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { EditorView } from "@codemirror/view";
import type { EditorMode } from "../../types";
import type { CursorPosition, EditorAdapter } from "./types";

export interface CodeMirrorAdapterDeps {
  view: EditorView;
  /** 用于挂载光标监听的 compartment（切换文档状态后需要重新注入） */
  selectionCompartment: Compartment;
  /** 宿主提供的模式切换实现（重建 WYSIWYG / 字体 / 快捷键 compartment） */
  applyMode: (mode: EditorMode) => void;
}

export function createCodeMirrorAdapter(deps: CodeMirrorAdapterDeps): EditorAdapter {
  const { view, selectionCompartment, applyMode } = deps;

  let currentMode: EditorMode = "source";
  let selectionExtension: Extension | null = null;

  function applySelectionExtension(): void {
    if (selectionExtension === null) return;
    view.dispatch({
      effects: selectionCompartment.reconfigure(selectionExtension),
    });
  }

  return {
    mount(host: HTMLElement): void {
      host.appendChild(view.dom);
    },

    destroy(): void {
      view.destroy();
    },

    getState(): unknown {
      return view.state;
    },

    setState(state: unknown): void {
      view.setState(state as EditorState);
      // 换入的状态来自缓存，不含本 adapter 的监听与当前模式配置
      applyMode(currentMode);
      applySelectionExtension();
    },

    replaceDoc(text: string): void {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        // 外部同步不进撤销栈
        annotations: Transaction.addToHistory.of(false),
      });
    },

    setMode(mode: EditorMode): void {
      currentMode = mode;
      applyMode(mode);
    },

    onSelectionChange(callback: (position: CursorPosition) => void): () => void {
      selectionExtension = EditorView.updateListener.of((update: ViewUpdate) => {
        if (!update.selectionSet && !update.docChanged) return;
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        callback({ line: line.number, ch: head - line.from });
      });

      applySelectionExtension();

      return () => {
        selectionExtension = null;
        view.dispatch({
          effects: selectionCompartment.reconfigure([]),
        });
      };
    },
  };
}
