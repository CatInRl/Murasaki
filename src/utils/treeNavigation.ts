import type { TreeNode } from "../types";

/**
 * 文件树键盘导航的纯逻辑（与 DOM 无关，便于单元测试）
 *
 * 设计要点：
 * - `flattenVisibleTree` 的产出顺序与渲染顺序一致（深度优先、父在子前、仅展开的目录带出后代），
 *   因此可以按下标直接驱动 roving tabindex 与方向键移动
 * - 方向键遵循 ARIA tree 惯例：首尾不循环；→ 展开 / 进入子节点；← 折叠 / 回到父节点
 */

/** 文件树中的一个可见条目 */
export interface FlatTreeItem {
  path: string;
  name: string;
  type: "file" | "directory";
  /** 缩进层级，从 0 开始 */
  level: number;
  /** 目录是否展开（已展开但无子节点的仍为 false）；文件恒为 false */
  expanded: boolean;
  /** 目录下是否有子节点；文件恒为 false */
  hasChildren: boolean;
}

/**
 * 按展开状态把文件树扁平化为「可见条目」列表。
 *
 * @param nodes 根节点列表
 * @param isExpanded 判断某目录路径是否处于展开状态
 */
export function flattenVisibleTree(
  nodes: TreeNode[],
  isExpanded: (path: string) => boolean
): FlatTreeItem[] {
  const out: FlatTreeItem[] = [];
  const walk = (list: TreeNode[], level: number): void => {
    for (const node of list) {
      const hasChildren =
        node.type === "directory" && (node.children?.length ?? 0) > 0;
      const expanded =
        node.type === "directory" && hasChildren && isExpanded(node.path);
      out.push({
        path: node.path,
        name: node.name,
        type: node.type,
        level,
        expanded,
        hasChildren,
      });
      if (expanded && node.children) {
        walk(node.children, level + 1);
      }
    }
  };
  walk(nodes, 0);
  return out;
}

/** 可见条目列表中某路径的下标；未找到返回 -1 */
export function indexOfPath(
  items: FlatTreeItem[],
  path: string | null
): number {
  if (!path) return -1;
  return items.findIndex((item) => item.path === path);
}

/** 线性移动类按键 */
export type TreeNavKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/**
 * 计算线性移动的目标下标（首尾不循环，到端点停在原地）。
 *
 * 当前无高亮（currentIndex < 0）时：↓ 落到第一项，↑ 落到最后一项。
 */
export function nextTreeIndex(
  items: FlatTreeItem[],
  currentIndex: number,
  key: TreeNavKey
): number {
  const last = items.length - 1;
  if (last < 0) return -1;
  switch (key) {
    case "Home":
      return 0;
    case "End":
      return last;
    case "ArrowDown":
      return currentIndex < 0 ? 0 : Math.min(currentIndex + 1, last);
    case "ArrowUp":
      return currentIndex < 0 ? last : Math.max(currentIndex - 1, 0);
  }
}

/** → 键的语义：展开目录（不改焦点）或聚焦某下标 */
export type TreeNavAction =
  | { kind: "expand"; path: string }
  | { kind: "collapse"; path: string }
  | { kind: "focus"; index: number };

/**
 * → 键：折叠的目录 → 展开；已展开的目录 → 聚焦第一个子节点；文件 / 叶子目录 → 无操作。
 */
export function rightArrowAction(
  items: FlatTreeItem[],
  currentIndex: number
): TreeNavAction | null {
  const item = items[currentIndex];
  if (!item || item.type !== "directory") return null;
  if (item.expanded) {
    const next = items[currentIndex + 1];
    return next && next.level > item.level
      ? { kind: "focus", index: currentIndex + 1 }
      : null;
  }
  return item.hasChildren ? { kind: "expand", path: item.path } : null;
}

/**
 * ← 键：展开的目录 → 折叠；其余情况 → 聚焦最近的父节点（层级更浅的上一项）。
 */
export function leftArrowAction(
  items: FlatTreeItem[],
  currentIndex: number
): TreeNavAction | null {
  const item = items[currentIndex];
  if (!item) return null;
  if (item.type === "directory" && item.expanded) {
    return { kind: "collapse", path: item.path };
  }
  for (let i = currentIndex - 1; i >= 0; i--) {
    if (items[i].level < item.level) return { kind: "focus", index: i };
  }
  return null;
}
