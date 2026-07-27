/**
 * Editor Bridge Store — 服务定位器
 *
 * SourceEditor.vue 在 onMounted 时注册当前活跃 tab 的 EditorView，
 * onBeforeUnmount 时注销。CM6 状态类工具通过它取 view。
 */
import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { EditorView } from "@codemirror/view";

export const useEditorBridgeStore = defineStore("editorBridge", () => {
  /** 当前活跃 EditorView（shallowRef，不深度响应式） */
  const editorView = shallowRef<EditorView | null>(null);
  /** 当前活跃 tab 的文件路径 */
  const activeDocPath = ref<string | null>(null);

  /** 注册 EditorView */
  function registerView(view: EditorView, docPath: string | null): void {
    editorView.value = view;
    activeDocPath.value = docPath;
  }

  /** 注销 EditorView */
  function unregisterView(view: EditorView): void {
    if (editorView.value === view) {
      editorView.value = null;
      activeDocPath.value = null;
    }
  }

  /** 更新当前文档路径（tab 切换时） */
  function updateDocPath(docPath: string | null): void {
    activeDocPath.value = docPath;
  }

  return {
    editorView,
    activeDocPath,
    registerView,
    unregisterView,
    updateDocPath,
  };
});
