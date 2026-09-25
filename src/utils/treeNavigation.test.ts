import { describe, it, expect } from "vitest";
import {
  flattenVisibleTree,
  indexOfPath,
  nextTreeIndex,
  rightArrowAction,
  leftArrowAction,
  type FlatTreeItem,
} from "./treeNavigation";
import type { TreeNode } from "../types";

/** 构造目录节点 */
function dir(name: string, children?: TreeNode[]): TreeNode {
  return { name, path: `/root/${name}`, type: "directory", children };
}

/** 构造文件节点 */
function file(name: string): TreeNode {
  return { name, path: `/root/${name}`, type: "file" };
}

/**
 * 树结构：
 * a/            (展开)
 *   a1.md
 *   sub/        (收起)
 *     deep.md
 * b/            (空目录)
 * c.md
 */
const tree: TreeNode[] = [
  dir("a", [file("a1.md"), dir("sub", [file("deep.md")])]),
  dir("b"),
  file("c.md"),
];

const expandedA = (path: string) => path === "/root/a";

/** 展开 a 与 sub */
const expandedBoth = (path: string) =>
  path === "/root/a" || path === "/root/sub";

describe("flattenVisibleTree", () => {
  it("仅展开的目录带出后代，顺序为深度优先、父在子前", () => {
    const items = flattenVisibleTree(tree, expandedA);
    expect(items.map((i) => i.name)).toEqual(["a", "a1.md", "sub", "b", "c.md"]);
    expect(items.map((i) => i.level)).toEqual([0, 1, 1, 0, 0]);
  });

  it("嵌套目录展开时后代层级递增", () => {
    const items = flattenVisibleTree(tree, expandedBoth);
    expect(items.map((i) => i.name)).toEqual([
      "a",
      "a1.md",
      "sub",
      "deep.md",
      "b",
      "c.md",
    ]);
    expect(items.map((i) => i.level)).toEqual([0, 1, 1, 2, 0, 0]);
  });

  it("全部收起时只剩根层节点", () => {
    const items = flattenVisibleTree(tree, () => false);
    expect(items.map((i) => i.name)).toEqual(["a", "b", "c.md"]);
  });

  it("目录的 expanded / hasChildren 标记正确，文件恒为 false", () => {
    const items = flattenVisibleTree(tree, expandedA);
    const a = items[0];
    expect(a).toMatchObject({ type: "directory", expanded: true, hasChildren: true });

    const sub = items[2];
    expect(sub).toMatchObject({ type: "directory", expanded: false, hasChildren: true });

    const b = items[3];
    expect(b).toMatchObject({ type: "directory", expanded: false, hasChildren: false });

    const c = items[4];
    expect(c).toMatchObject({ type: "file", expanded: false, hasChildren: false });
  });

  it("空树返回空列表", () => {
    expect(flattenVisibleTree([], expandedA)).toEqual([]);
  });
});

describe("indexOfPath", () => {
  const items = flattenVisibleTree(tree, expandedA);

  it("命中返回下标", () => {
    expect(indexOfPath(items, "/root/a")).toBe(0);
    expect(indexOfPath(items, "/root/b")).toBe(3);
  });

  it("未命中或路径为空返回 -1", () => {
    expect(indexOfPath(items, "/root/nowhere")).toBe(-1);
    expect(indexOfPath(items, null)).toBe(-1);
  });
});

describe("nextTreeIndex", () => {
  const items = flattenVisibleTree(tree, expandedA);

  it("Home / End 落到首尾", () => {
    expect(nextTreeIndex(items, 2, "Home")).toBe(0);
    expect(nextTreeIndex(items, 1, "End")).toBe(items.length - 1);
  });

  it("↓ / ↑ 线性移动", () => {
    expect(nextTreeIndex(items, 0, "ArrowDown")).toBe(1);
    expect(nextTreeIndex(items, 2, "ArrowUp")).toBe(1);
  });

  it("首尾不循环，到端点停在原地", () => {
    const last = items.length - 1;
    expect(nextTreeIndex(items, last, "ArrowDown")).toBe(last);
    expect(nextTreeIndex(items, 0, "ArrowUp")).toBe(0);
  });

  it("无高亮时 ↓ 落到第一项、↑ 落到最后一项", () => {
    expect(nextTreeIndex(items, -1, "ArrowDown")).toBe(0);
    expect(nextTreeIndex(items, -1, "ArrowUp")).toBe(items.length - 1);
  });

  it("空列表返回 -1", () => {
    expect(nextTreeIndex([], 0, "ArrowDown")).toBe(-1);
  });
});

describe("rightArrowAction", () => {
  const collapsed = flattenVisibleTree(tree, () => false);
  const items = flattenVisibleTree(tree, expandedA);

  it("折叠的目录 → 展开", () => {
    // collapsed: [a, b, c.md]
    expect(rightArrowAction(collapsed, 0)).toEqual({ kind: "expand", path: "/root/a" });
  });

  it("已展开的目录 → 聚焦第一个子节点", () => {
    // items: [a, a1.md, sub, b, c.md]
    expect(rightArrowAction(items, 0)).toEqual({ kind: "focus", index: 1 });
  });

  it("叶子目录（无子节点）→ 无操作", () => {
    expect(rightArrowAction(collapsed, 1)).toBeNull();
  });

  it("文件 → 无操作", () => {
    expect(rightArrowAction(collapsed, 2)).toBeNull();
  });

  it("下标越界 → 无操作", () => {
    expect(rightArrowAction(collapsed, 99)).toBeNull();
  });
});

describe("leftArrowAction", () => {
  const collapsed = flattenVisibleTree(tree, () => false);
  const items = flattenVisibleTree(tree, expandedBoth);

  it("展开的目录 → 折叠", () => {
    expect(leftArrowAction(items, 0)).toEqual({ kind: "collapse", path: "/root/a" });
  });

  it("子节点 → 聚焦父节点", () => {
    // items: [a, a1.md, sub, deep.md, b, c.md]
    expect(leftArrowAction(items, 1)).toEqual({ kind: "focus", index: 0 });
    expect(leftArrowAction(items, 3)).toEqual({ kind: "focus", index: 2 });
  });

  it("根层非展开项 → 无操作", () => {
    expect(leftArrowAction(collapsed, 0)).toBeNull();
    expect(leftArrowAction(collapsed, 2)).toBeNull();
  });

  it("下标越界 → 无操作", () => {
    expect(leftArrowAction(items, 99)).toBeNull();
  });
});

describe("FlatTreeItem 类型可用性", () => {
  it("字段齐备", () => {
    const item: FlatTreeItem = {
      path: "/root/x",
      name: "x",
      type: "file",
      level: 0,
      expanded: false,
      hasChildren: false,
    };
    expect(item.path).toBe("/root/x");
  });
});
