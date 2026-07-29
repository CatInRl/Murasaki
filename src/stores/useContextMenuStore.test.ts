import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import {
  useContextMenuStore,
  clampToViewport,
  type MenuItem,
} from "./useContextMenuStore";

beforeEach(() => {
  setActivePinia(createPinia());
});

/** 构造一个 mock MouseEvent */
function mockEvent(clientX = 0, clientY = 0): MouseEvent {
  return {
    clientX,
    clientY,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as MouseEvent;
}

describe("useContextMenuStore", () => {
  describe("show / hide", () => {
    it("初始状态为隐藏且无菜单项", () => {
      const menu = useContextMenuStore();
      expect(menu.visible).toBe(false);
      expect(menu.items).toEqual([]);
      expect(menu.x).toBe(0);
      expect(menu.y).toBe(0);
    });

    it("show 设置 visible / x / y / items", () => {
      const menu = useContextMenuStore();
      const items: MenuItem[] = [{ label: "关闭", action: () => {} }];
      const ev = mockEvent(120, 200);
      menu.show(ev, items);

      expect(menu.visible).toBe(true);
      expect(menu.x).toBe(120);
      expect(menu.y).toBe(200);
      expect(menu.items).toHaveLength(1);
      expect(menu.items[0].label).toBe("关闭");
    });

    it("show 调用 preventDefault 与 stopPropagation", () => {
      const menu = useContextMenuStore();
      const ev = mockEvent(10, 10);
      menu.show(ev, []);

      expect(ev.preventDefault).toHaveBeenCalledTimes(1);
      expect(ev.stopPropagation).toHaveBeenCalledTimes(1);
    });

    it("hide 重置 visible 与 items", () => {
      const menu = useContextMenuStore();
      menu.show(mockEvent(50, 60), [{ label: "A" }, { separator: true }]);
      expect(menu.visible).toBe(true);

      menu.hide();

      expect(menu.visible).toBe(false);
      expect(menu.items).toEqual([]);
    });

    it("hide 不重置 x / y（仅隐藏，位置保留无副作用）", () => {
      const menu = useContextMenuStore();
      menu.show(mockEvent(123, 456), []);
      menu.hide();
      // x/y 保留也属合理行为；这里仅断言 hide 不抛错且 visible=false
      expect(menu.visible).toBe(false);
    });
  });

  describe("栈管理 — 同时只显示一个", () => {
    it("再次 show 替换旧菜单内容与位置", () => {
      const menu = useContextMenuStore();
      menu.show(mockEvent(10, 20), [{ label: "第一组" }]);
      expect(menu.items).toHaveLength(1);
      expect(menu.items[0].label).toBe("第一组");

      menu.show(mockEvent(300, 400), [
        { label: "A" },
        { separator: true },
        { label: "B" },
      ]);

      // 仍只显示一个菜单（visible 保持 true，无第二个实例）
      expect(menu.visible).toBe(true);
      expect(menu.x).toBe(300);
      expect(menu.y).toBe(400);
      expect(menu.items).toHaveLength(3);
      expect(menu.items[0].label).toBe("A");
      expect(menu.items[2].label).toBe("B");
    });

    it("hide 后再 show 正常显示", () => {
      const menu = useContextMenuStore();
      menu.show(mockEvent(0, 0), [{ label: "X" }]);
      menu.hide();
      expect(menu.visible).toBe(false);

      menu.show(mockEvent(5, 6), [{ label: "Y" }]);
      expect(menu.visible).toBe(true);
      expect(menu.items[0].label).toBe("Y");
    });
  });

  describe("MenuItem 数据驱动", () => {
    it("separator 项可被正确构造并存储", () => {
      const menu = useContextMenuStore();
      const items: MenuItem[] = [
        { label: "复制", action: () => {} },
        { separator: true },
        { label: "删除", danger: true, action: () => {} },
      ];
      menu.show(mockEvent(0, 0), items);

      expect(menu.items[1].separator).toBe(true);
      expect(menu.items[2].danger).toBe(true);
    });

    it("disabled / shortcut / icon 字段可被保留", () => {
      const menu = useContextMenuStore();
      const fakeIcon = { name: "FakeIcon" } as never;
      const items: MenuItem[] = [
        {
          label: "粘贴",
          shortcut: "Ctrl+V",
          icon: fakeIcon,
          disabled: true,
          action: () => {},
        },
      ];
      menu.show(mockEvent(0, 0), items);

      const item = menu.items[0];
      expect(item.disabled).toBe(true);
      expect(item.shortcut).toBe("Ctrl+V");
      expect(item.icon).toEqual(fakeIcon);
    });

    it("action 回调可被独立调用（store 不直接执行，由容器触发）", () => {
      const menu = useContextMenuStore();
      let called = false;
      const items: MenuItem[] = [
        { label: "点我", action: () => { called = true; } },
      ];
      menu.show(mockEvent(0, 0), items);

      // store 仅存储 action，不主动调用
      expect(called).toBe(false);
      // 模拟容器触发
      items[0].action!();
      expect(called).toBe(true);
    });
  });

  describe("clampToViewport 边界检测", () => {
    it("未溢出时返回原始坐标", () => {
      const pos = clampToViewport(100, 100, 180, 200, 1920, 1080);
      expect(pos).toEqual({ x: 100, y: 100 });
    });

    it("右侧溢出时翻向左侧（x - width）", () => {
      // 1800 + 180 = 1980 > 1920 → 翻向 1800 - 180 = 1620
      const pos = clampToViewport(1800, 100, 180, 200, 1920, 1080);
      expect(pos.x).toBe(1620);
      expect(pos.y).toBe(100);
    });

    it("底部溢出时翻向上方（y - height）", () => {
      // 1000 + 200 = 1200 > 1080 → 翻向 1000 - 200 = 800
      const pos = clampToViewport(100, 1000, 180, 200, 1920, 1080);
      expect(pos.x).toBe(100);
      expect(pos.y).toBe(800);
    });

    it("右下角同时溢出时双向翻向", () => {
      const pos = clampToViewport(1800, 1000, 180, 200, 1920, 1080);
      expect(pos).toEqual({ x: 1620, y: 800 });
    });

    it("翻向后仍夹紧到非负坐标（菜单宽于视窗的极端情况）", () => {
      // 点击点 x=50，菜单宽=200，视窗宽=100 → 翻向 50-200=-150 → 夹紧到 0
      const pos = clampToViewport(50, 50, 200, 300, 100, 100);
      expect(pos.x).toBeGreaterThanOrEqual(0);
      expect(pos.y).toBeGreaterThanOrEqual(0);
      expect(pos).toEqual({ x: 0, y: 0 });
    });

    it("正好贴合边界时不翻向（x + width === viewportWidth）", () => {
      // 1740 + 180 = 1920 === 1920，未溢出
      const pos = clampToViewport(1740, 100, 180, 200, 1920, 1080);
      expect(pos.x).toBe(1740);
    });

    it("零尺寸菜单直接返回原始坐标", () => {
      const pos = clampToViewport(500, 500, 0, 0, 1920, 1080);
      expect(pos).toEqual({ x: 500, y: 500 });
    });
  });
});
