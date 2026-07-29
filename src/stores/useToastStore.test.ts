/**
 * useToastStore 单元测试 (Ticket #65 / T2.1 吐司系统)
 *
 * 覆盖：
 * - 队列管理：push/success/info/warning/error/progress/deleted 入队、返回 id
 * - 自动消失：各变体默认延迟（success/info 3s、warning/error 5s、progress 不消失、deleted 10s）
 * - duration 覆盖：自定义延迟、0 表示不自动消失
 * - action 回调：携带 action 时回调可触发
 * - dismiss：按 id 移除并清空计时器
 * - dismissAll：清空全部
 * - update：更新字段、duration 变更重新调度
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useToastStore } from "./useToastStore";

describe("useToastStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("队列管理 - 入队与返回 id", () => {
    it("初始队列为空", () => {
      const store = useToastStore();
      expect(store.toasts).toHaveLength(0);
    });

    it("success 入队并返回 id", () => {
      const store = useToastStore();
      const id = store.success("保存成功");
      expect(id).toBeTruthy();
      expect(store.toasts).toHaveLength(1);
      expect(store.toasts[0].title).toBe("保存成功");
      expect(store.toasts[0].variant).toBe("success");
    });

    it("6 个变体均可入队", () => {
      const store = useToastStore();
      store.success("s");
      store.info("i");
      store.warning("w");
      store.error("e");
      store.progress("p");
      store.deleted("d");
      expect(store.toasts).toHaveLength(6);
      const variants = store.toasts.map((t) => t.variant);
      expect(variants).toEqual([
        "success",
        "info",
        "warning",
        "error",
        "progress",
        "deleted",
      ]);
    });

    it("每次入队返回唯一 id", () => {
      const store = useToastStore();
      const id1 = store.success("a");
      const id2 = store.success("b");
      expect(id1).not.toBe(id2);
    });

    it("携带 description 与 action 选项", () => {
      const store = useToastStore();
      const action = { label: "撤销", onClick: () => {} };
      store.success("已保存", { description: "notes/a.md", action });
      const toast = store.toasts[0];
      expect(toast.description).toBe("notes/a.md");
      expect(toast.action).toEqual(action);
    });
  });

  describe("自动消失 - 默认延迟", () => {
    it("success 3s 后自动消失", () => {
      const store = useToastStore();
      store.success("ok");
      expect(store.toasts).toHaveLength(1);
      vi.advanceTimersByTime(2999);
      expect(store.toasts).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(store.toasts).toHaveLength(0);
    });

    it("info 3s 后自动消失", () => {
      const store = useToastStore();
      store.info("info");
      vi.advanceTimersByTime(3000);
      expect(store.toasts).toHaveLength(0);
    });

    it("warning 5s 后自动消失", () => {
      const store = useToastStore();
      store.warning("warn");
      vi.advanceTimersByTime(4999);
      expect(store.toasts).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(store.toasts).toHaveLength(0);
    });

    it("error 5s 后自动消失", () => {
      const store = useToastStore();
      store.error("err");
      vi.advanceTimersByTime(5000);
      expect(store.toasts).toHaveLength(0);
    });

    it("progress 不自动消失", () => {
      const store = useToastStore();
      store.progress("loading");
      vi.advanceTimersByTime(60000);
      expect(store.toasts).toHaveLength(1);
    });

    it("deleted 10s 后自动消失", () => {
      const store = useToastStore();
      store.deleted("已删除");
      vi.advanceTimersByTime(9999);
      expect(store.toasts).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(store.toasts).toHaveLength(0);
    });
  });

  describe("duration 覆盖", () => {
    it("自定义 duration 覆盖默认延迟", () => {
      const store = useToastStore();
      store.success("ok", { duration: 1000 });
      vi.advanceTimersByTime(999);
      expect(store.toasts).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(store.toasts).toHaveLength(0);
    });

    it("duration: 0 表示不自动消失", () => {
      const store = useToastStore();
      store.success("sticky", { duration: 0 });
      vi.advanceTimersByTime(60000);
      expect(store.toasts).toHaveLength(1);
    });
  });

  describe("action 回调", () => {
    it("action 字段正确存储", () => {
      const store = useToastStore();
      const onClick = vi.fn();
      store.deleted("已删除", { action: { label: "撤销", onClick } });
      expect(store.toasts[0].action?.label).toBe("撤销");
      expect(store.toasts[0].action?.onClick).toBe(onClick);
    });

    it("自动消失前 action 仍可被外部调用", () => {
      const store = useToastStore();
      let called = false;
      store.deleted("已删除", {
        action: {
          label: "撤销",
          onClick: () => {
            called = true;
          },
        },
      });
      store.toasts[0].action?.onClick();
      expect(called).toBe(true);
    });
  });

  describe("dismiss", () => {
    it("按 id 移除指定吐司", () => {
      const store = useToastStore();
      const id1 = store.success("a");
      const id2 = store.success("b");
      store.dismiss(id1);
      expect(store.toasts).toHaveLength(1);
      expect(store.toasts[0].id).toBe(id2);
    });

    it("dismiss 不存在的 id 为空操作", () => {
      const store = useToastStore();
      store.success("a");
      store.dismiss("nonexistent");
      expect(store.toasts).toHaveLength(1);
    });

    it("dismiss 取消自动消失计时器", () => {
      const store = useToastStore();
      const id = store.success("a");
      store.dismiss(id);
      vi.advanceTimersByTime(10000);
      expect(store.toasts).toHaveLength(0);
    });
  });

  describe("dismissAll", () => {
    it("清空所有吐司", () => {
      const store = useToastStore();
      store.success("a");
      store.warning("b");
      store.error("c");
      expect(store.toasts).toHaveLength(3);
      store.dismissAll();
      expect(store.toasts).toHaveLength(0);
    });

    it("清空后自动消失计时器被取消", () => {
      const store = useToastStore();
      store.success("a");
      store.success("b");
      store.dismissAll();
      vi.advanceTimersByTime(10000);
      expect(store.toasts).toHaveLength(0);
    });
  });

  describe("update", () => {
    it("更新 description 字段", () => {
      const store = useToastStore();
      const id = store.progress("加载中");
      store.update(id, { description: "50% 完成" });
      expect(store.toasts[0].description).toBe("50% 完成");
    });

    it("更新 progress 字段", () => {
      const store = useToastStore();
      const id = store.progress("加载中", { progress: 10 });
      store.update(id, { progress: 75 });
      expect(store.toasts[0].progress).toBe(75);
    });

    it("更新不存在的 id 为空操作", () => {
      const store = useToastStore();
      store.update("nonexistent", { description: "x" });
      expect(store.toasts).toHaveLength(0);
    });

    it("更新 duration 重新调度自动消失", () => {
      const store = useToastStore();
      const id = store.progress("加载中");
      store.update(id, { duration: 2000 });
      vi.advanceTimersByTime(1999);
      expect(store.toasts).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(store.toasts).toHaveLength(0);
    });

    it("更新 title 字段", () => {
      const store = useToastStore();
      const id = store.success("原标题");
      store.update(id, { title: "新标题" });
      expect(store.toasts[0].title).toBe("新标题");
    });
  });
});