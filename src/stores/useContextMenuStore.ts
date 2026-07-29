import { defineStore } from "pinia";
import { ref } from "vue";
import type { Component } from "vue";

/**
 * 右键菜单项（数据驱动）
 *
 * 一项 MenuItem 对应菜单中的一行；当 `separator: true` 时为分隔符，
 * 其余字段将被忽略。
 *
 * 设计要点：
 * - `action` 由调用方注入闭包，store / 容器只负责渲染与触发
 * - `icon` 为 lucide-vue-next 组件（或任意 Vue 组件），由容器用 <component :is>
 * - `shortcut` 仅作显示提示，不绑定实际快捷键
 */
export interface MenuItem {
  /** 显示文本（分隔符项可省略） */
  label?: string;
  /** 图标组件（lucide-vue-next） */
  icon?: Component;
  /** 快捷键提示文本（仅显示） */
  shortcut?: string;
  /** 点击时执行的回调（分隔符 / 禁用项无 action） */
  action?: () => void | Promise<void>;
  /** 是否禁用 */
  disabled?: boolean;
  /** 是否为危险操作（红色文字，hover 红底白字） */
  danger?: boolean;
  /** 是否为分隔符 */
  separator?: boolean;
}

export interface MenuPosition {
  x: number;
  y: number;
}

/**
 * 边界检测：将菜单位置限制在视窗内。
 *
 * - 右侧溢出 → 菜单左对齐到点击点左侧（x - width），并夹紧到 ≥ 0
 * - 底部溢出 → 菜单上对齐到点击点上方（y - height），并夹紧到 ≥ 0
 * - 不改变未溢出方向的坐标
 *
 * 抽出为纯函数便于单元测试。
 */
export function clampToViewport(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number
): MenuPosition {
  let clampedX = x;
  let clampedY = y;
  if (x + menuWidth > viewportWidth) {
    clampedX = Math.max(0, x - menuWidth);
  }
  if (y + menuHeight > viewportHeight) {
    clampedY = Math.max(0, y - menuHeight);
  }
  return { x: clampedX, y: clampedY };
}

/**
 * 右键菜单 Store — 全局唯一，数据驱动。
 *
 * 栈管理：同时只显示一个菜单；再次调用 `show` 会替换当前菜单的内容与位置。
 */
export const useContextMenuStore = defineStore("contextMenu", () => {
  const visible = ref(false);
  const x = ref(0);
  const y = ref(0);
  const items = ref<MenuItem[]>([]);

  /**
   * 显示右键菜单。
   *
   * 调用方应在 `contextmenu` 事件中直接传入 `event`，本方法会 preventDefault +
   * stopPropagation，避免浏览器原生菜单与事件冒泡触发重复关闭。
   *
   * 栈管理：新 show 自动覆盖旧菜单（visible 一直为 true 时也会刷新 x/y/items）。
   */
  function show(event: MouseEvent, menuItems: MenuItem[]): void {
    event.preventDefault();
    event.stopPropagation();
    x.value = event.clientX;
    y.value = event.clientY;
    items.value = menuItems;
    visible.value = true;
  }

  /** 隐藏右键菜单（点击菜单项 / 点击外部 / Escape / 滚动时由容器调用） */
  function hide(): void {
    visible.value = false;
    items.value = [];
  }

  return { visible, x, y, items, show, hide };
});
