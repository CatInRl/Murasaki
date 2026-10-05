/**
 * 标签栏键盘导航（#386 roving tabindex）的纯逻辑层
 *
 * TabBar.vue 的 keydown 处理只做三件事：取 action → preventDefault → 应用。
 * 方向键 / Home / End 只移动焦点（手动激活模式），Enter / Space 激活，Delete 关闭。
 */

export interface TabKeyAction {
  /** 目标标签下标（激活 / 关闭时即当前下标） */
  nextIndex: number;
  /** 是否激活目标标签 */
  activate: boolean;
  /** 是否关闭当前标签 */
  close: boolean;
}

/**
 * 把按键翻译为标签栏动作；不认识的键返回 null（不拦截，交给默认行为）。
 * 方向键在两端回绕（与文件树键盘导航一致），单标签时原位不动。
 */
export function tabKeyAction(key: string, index: number, count: number): TabKeyAction | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return { nextIndex: (index + 1) % count, activate: false, close: false };
    case "ArrowLeft":
      return { nextIndex: (index - 1 + count) % count, activate: false, close: false };
    case "Home":
      return { nextIndex: 0, activate: false, close: false };
    case "End":
      return { nextIndex: count - 1, activate: false, close: false };
    case "Enter":
    case " ":
      return { nextIndex: index, activate: true, close: false };
    case "Delete":
      return { nextIndex: index, activate: false, close: true };
    default:
      return null;
  }
}
