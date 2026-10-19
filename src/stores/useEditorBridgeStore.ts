/**
 * Editor Bridge Store — 服务定位器
 *
 * 曾经还持有当前活跃的 `EditorView` 与 `activeDocPath`，但应用代码**从不读它们**
 * （ADR-0022 记过：读取次数为 0）。编辑器自身的句柄由 `App.vue` 的 `editorRef`
 * 与 `SourceEditor` 内部持有，跨文档状态由编辑会话（`src/editor/session/`）持有 ——
 * 这里再存一份只是多一个会过期的副本，Phase 3 一并删除。
 *
 * 现在只剩「编辑模式」这一件真正被读取的运行时状态。
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import type { EditorMode } from "../types";

/** 显示模式（定义在 types.ts，此处转出便于既有引用） */
export type { EditorMode };

export const useEditorBridgeStore = defineStore("editorBridge", () => {
  /** 当前编辑器模式（运行时可切换；由 App.vue 从 persistence.settings 初始化并同步） */
  const editorMode = ref<EditorMode>("split");

  /** 切换当前编辑器模式（运行时，无需重启） */
  function setEditorMode(mode: EditorMode): void {
    editorMode.value = mode;
  }

  return {
    editorMode,
    setEditorMode,
  };
});
