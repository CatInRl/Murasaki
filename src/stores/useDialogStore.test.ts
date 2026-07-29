import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useDialogStore } from "./useDialogStore";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("useDialogStore", () => {
  describe("alert", () => {
    it("返回 Promise，confirmCurrent 后 resolve undefined", async () => {
      const dialog = useDialogStore();
      const p = dialog.alert({ message: "test" });
      expect(dialog.isOpen).toBe(true);
      expect(dialog.current?.kind).toBe("alert");
      dialog.confirmCurrent();
      await expect(p).resolves.toBeUndefined();
      expect(dialog.isOpen).toBe(false);
    });

    it("cancelCurrent 等同确定（resolve undefined）", async () => {
      const dialog = useDialogStore();
      const p = dialog.alert({ message: "test" });
      dialog.cancelCurrent();
      await expect(p).resolves.toBeUndefined();
    });

    it("variant 默认 info，标题为 '提示'", () => {
      const dialog = useDialogStore();
      dialog.alert({ message: "test" });
      expect(dialog.current?.variant).toBe("info");
      expect(dialog.current?.title).toBe("提示");
    });

    it("variant warning 设置标题为 '警告'", () => {
      const dialog = useDialogStore();
      dialog.alert({ message: "test", variant: "warning" });
      expect(dialog.current?.variant).toBe("warning");
      expect(dialog.current?.title).toBe("警告");
    });

    it("variant error 设置标题为 '错误'", () => {
      const dialog = useDialogStore();
      dialog.alert({ message: "test", variant: "error" });
      expect(dialog.current?.variant).toBe("error");
      expect(dialog.current?.title).toBe("错误");
    });

    it("自定义标题覆盖默认", () => {
      const dialog = useDialogStore();
      dialog.alert({ message: "test", title: "自定义" });
      expect(dialog.current?.title).toBe("自定义");
    });
  });

  describe("confirm", () => {
    it("confirmCurrent 返回 true", async () => {
      const dialog = useDialogStore();
      const p = dialog.confirm({ message: "test" });
      dialog.confirmCurrent();
      await expect(p).resolves.toBe(true);
    });

    it("cancelCurrent 返回 false（Escape 行为）", async () => {
      const dialog = useDialogStore();
      const p = dialog.confirm({ message: "test" });
      dialog.cancelCurrent();
      await expect(p).resolves.toBe(false);
    });

    it("danger 标志默认 false", () => {
      const dialog = useDialogStore();
      dialog.confirm({ message: "test" });
      expect(dialog.current?.danger).toBe(false);
    });

    it("danger 标志设为 true", () => {
      const dialog = useDialogStore();
      dialog.confirm({ message: "test", danger: true });
      expect(dialog.current?.danger).toBe(true);
    });
  });

  describe("prompt", () => {
    it("submitPrompt 返回输入值", async () => {
      const dialog = useDialogStore();
      const p = dialog.prompt({ message: "test" });
      dialog.updatePromptInput("hello");
      dialog.submitPrompt();
      await expect(p).resolves.toBe("hello");
    });

    it("cancelCurrent 返回 null（Escape 行为）", async () => {
      const dialog = useDialogStore();
      const p = dialog.prompt({ message: "test" });
      dialog.cancelCurrent();
      await expect(p).resolves.toBe(null);
    });

    it("defaultValue 设置 inputValue", () => {
      const dialog = useDialogStore();
      dialog.prompt({ message: "test", defaultValue: "default" });
      expect(dialog.current?.inputValue).toBe("default");
    });

    it("validate 校验失败时阻止提交并设置错误信息", async () => {
      const dialog = useDialogStore();
      const p = dialog.prompt({
        message: "test",
        validate: (v) => (v.length < 3 ? "too short" : null),
      });
      dialog.updatePromptInput("ab");
      dialog.submitPrompt();
      expect(dialog.isOpen).toBe(true);
      expect(dialog.current?.validationError).toBe("too short");
      dialog.updatePromptInput("abcd");
      dialog.submitPrompt();
      await expect(p).resolves.toBe("abcd");
    });

    it("updatePromptInput 清除校验错误", () => {
      const dialog = useDialogStore();
      dialog.prompt({
        message: "test",
        validate: (v) => (v.length < 3 ? "too short" : null),
      });
      dialog.updatePromptInput("ab");
      dialog.submitPrompt();
      expect(dialog.current?.validationError).toBe("too short");
      dialog.updatePromptInput("abc");
      expect(dialog.current?.validationError).toBe(null);
    });
  });
  describe("conflict", () => {
    it("conflictOverwrite 返回 { action: 'overwrite' }", async () => {
      const dialog = useDialogStore();
      const p = dialog.conflict({ filename: "test.md" });
      dialog.conflictOverwrite();
      await expect(p).resolves.toEqual({ action: "overwrite" });
    });

    it("cancelCurrent 返回 { action: 'cancel' }（Escape 行为）", async () => {
      const dialog = useDialogStore();
      const p = dialog.conflict({ filename: "test.md" });
      dialog.cancelCurrent();
      await expect(p).resolves.toEqual({ action: "cancel" });
    });

    it("conflictRename 两步流程：先展开输入框，再提交新名称", async () => {
      const dialog = useDialogStore();
      const p = dialog.conflict({ filename: "test.md" });
      expect(dialog.current?.showRenameInput).toBe(false);
      dialog.conflictRename();
      expect(dialog.current?.showRenameInput).toBe(true);
      expect(dialog.current?.inputValue).toBe("test.md");
      dialog.updateConflictRenameInput("new-name.md");
      dialog.conflictRename();
      await expect(p).resolves.toEqual({
        action: "rename",
        newName: "new-name.md",
      });
    });

    it("conflictRename 同名时阻止提交", () => {
      const dialog = useDialogStore();
      dialog.conflict({ filename: "test.md" });
      dialog.conflictRename();
      dialog.conflictRename();
      expect(dialog.isOpen).toBe(true);
      expect(dialog.current?.validationError).toBe("新名称与原名称相同");
    });

    it("conflictRename 空名称时阻止提交", () => {
      const dialog = useDialogStore();
      dialog.conflict({ filename: "test.md" });
      dialog.conflictRename();
      dialog.updateConflictRenameInput("   ");
      dialog.conflictRename();
      expect(dialog.isOpen).toBe(true);
    });

    it("默认标题根据 operation 设置", () => {
      const dialog = useDialogStore();
      dialog.conflict({ filename: "test.md", operation: "copy" });
      expect(dialog.current?.title).toBe("复制冲突");
    });
  });

  describe("模态栈管理", () => {
    it("同时只显示一个对话框（队列头部）", () => {
      const dialog = useDialogStore();
      dialog.alert({ message: "first" });
      dialog.confirm({ message: "second" });
      expect(dialog.current?.message).toBe("first");
      expect(dialog.current?.kind).toBe("alert");
    });

    it("第一个 resolve 后自动显示第二个", () => {
      const dialog = useDialogStore();
      dialog.alert({ message: "first" });
      dialog.confirm({ message: "second" });
      dialog.confirmCurrent();
      expect(dialog.current?.message).toBe("second");
      expect(dialog.current?.kind).toBe("confirm");
    });

    it("队列按顺序 resolve", async () => {
      const dialog = useDialogStore();
      const p1 = dialog.alert({ message: "first" });
      const p2 = dialog.confirm({ message: "second" });
      const p3 = dialog.prompt({ message: "third" });

      dialog.confirmCurrent();
      await expect(p1).resolves.toBeUndefined();

      dialog.confirmCurrent();
      await expect(p2).resolves.toBe(true);

      dialog.updatePromptInput("val");
      dialog.submitPrompt();
      await expect(p3).resolves.toBe("val");

      expect(dialog.isOpen).toBe(false);
    });

    it("current 在队列为空时为 null", () => {
      const dialog = useDialogStore();
      expect(dialog.current).toBe(null);
      dialog.alert({ message: "test" });
      expect(dialog.current).not.toBe(null);
      dialog.confirmCurrent();
      expect(dialog.current).toBe(null);
    });
  });

  describe("Escape 行为（cancelCurrent）", () => {
    it("alert: cancelCurrent resolve undefined", async () => {
      const dialog = useDialogStore();
      const p = dialog.alert({ message: "test" });
      dialog.cancelCurrent();
      await expect(p).resolves.toBeUndefined();
    });

    it("confirm: cancelCurrent resolve false", async () => {
      const dialog = useDialogStore();
      const p = dialog.confirm({ message: "test" });
      dialog.cancelCurrent();
      await expect(p).resolves.toBe(false);
    });

    it("prompt: cancelCurrent resolve null", async () => {
      const dialog = useDialogStore();
      const p = dialog.prompt({ message: "test" });
      dialog.cancelCurrent();
      await expect(p).resolves.toBe(null);
    });

    it("conflict: cancelCurrent resolve { action: 'cancel' }", async () => {
      const dialog = useDialogStore();
      const p = dialog.conflict({ filename: "test.md" });
      dialog.cancelCurrent();
      await expect(p).resolves.toEqual({ action: "cancel" });
    });

    it("队列为空时 cancelCurrent 无副作用", () => {
      const dialog = useDialogStore();
      expect(() => dialog.cancelCurrent()).not.toThrow();
      expect(dialog.isOpen).toBe(false);
    });
  });
});