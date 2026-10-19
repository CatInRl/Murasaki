import { setActivePinia, createPinia } from "pinia";
import { describe, it, expect, beforeEach } from "vitest";
import { useEditorBridgeStore, type EditorMode } from "./useEditorBridgeStore";

describe("useEditorBridgeStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  describe("editorMode", () => {
    it("默认值为 split", () => {
      const store = useEditorBridgeStore();
      expect(store.editorMode).toBe("split");
    });

    it("setEditorMode 可切换到 source / split / wysiwyg", () => {
      const store = useEditorBridgeStore();
      const modes: EditorMode[] = ["source", "split", "wysiwyg"];
      for (const m of modes) {
        store.setEditorMode(m);
        expect(store.editorMode).toBe(m);
      }
    });

    it("连续切换均生效（运行时切换语义）", () => {
      const store = useEditorBridgeStore();
      const sequence: EditorMode[] = ["wysiwyg", "source", "split", "wysiwyg", "source", "split"];
      for (const m of sequence) {
        store.setEditorMode(m);
        expect(store.editorMode).toBe(m);
      }
    });

    it("editorMode 是 store 暴露的字段", () => {
      const store = useEditorBridgeStore();
      expect(Object.keys(store)).toContain("editorMode");
      expect(Object.keys(store)).toContain("setEditorMode");
    });
  });

  describe("已删除的死状态（ADR-0022 Phase 3）", () => {
    // 这两个字段过去只有写入、没有读取。留一个断言防止它们被"顺手加回来"：
    // 编辑器句柄应由编辑会话（src/editor/session/）或组件自身持有，
    // 再往 store 里存一份只会产生会过期的副本。
    it("不再暴露 editorView / activeDocPath", () => {
      const store = useEditorBridgeStore();
      expect(Object.keys(store)).not.toContain("editorView");
      expect(Object.keys(store)).not.toContain("activeDocPath");
      expect(Object.keys(store)).not.toContain("updateDocPath");
      expect(Object.keys(store)).not.toContain("registerView");
      expect(Object.keys(store)).not.toContain("unregisterView");
    });
  });
});
