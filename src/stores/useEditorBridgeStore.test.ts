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
      const sequence: EditorMode[] = [
        "wysiwyg",
        "source",
        "split",
        "wysiwyg",
        "source",
        "split",
      ];
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

  describe("updateDocPath 与 editorMode 解耦", () => {
    it("切换文档路径不影响 editorMode", () => {
      const store = useEditorBridgeStore();
      store.setEditorMode("wysiwyg");
      store.updateDocPath("/some/path.md");
      expect(store.activeDocPath).toBe("/some/path.md");
      expect(store.editorMode).toBe("wysiwyg");
    });

    it("切换 editorMode 不影响 activeDocPath", () => {
      const store = useEditorBridgeStore();
      store.updateDocPath("/keep/this.md");
      store.setEditorMode("source");
      expect(store.activeDocPath).toBe("/keep/this.md");
      expect(store.editorMode).toBe("source");
    });
  });
});
