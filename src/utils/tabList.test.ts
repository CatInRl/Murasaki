/**
 * 「全部标签」列表派生与过滤测试（issue #168 / #279）
 */
import { describe, it, expect } from "vitest";
import { buildTabList, filterTabList } from "./tabList";
import type { Tab } from "../types";

function tab(partial: Partial<Tab> & { id: string }): Tab {
  return {
    path: null,
    content: "",
    savedContent: "",
    lastMtime: null,
    isDirty: false,
    hasExternalChange: false,
    cursor: 0,
    scroll: 0,
    ...partial,
  } as Tab;
}

const titleOf = (t: Tab) => (t.path ? t.path.split(/[\\/]/).pop()! : "未命名");

describe("buildTabList", () => {
  it("保持标签栏顺序，并标注激活项", () => {
    const tabs = [
      tab({ id: "a", path: "/ws/docs/a.md" }),
      tab({ id: "b", path: "/ws/b.md" }),
      tab({ id: "c", path: "/ws/c.md" }),
    ];
    const list = buildTabList(tabs, {
      activeTabId: "b",
      workspacePath: "/ws",
      titleOf,
    });
    expect(list.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(list.map((e) => e.isActive)).toEqual([false, true, false]);
  });

  it("副标题取所在目录；未命名标签为 null", () => {
    const tabs = [
      tab({ id: "a", path: "/ws/docs/sub/a.md" }),
      tab({ id: "u", path: null }),
    ];
    const list = buildTabList(tabs, { activeTabId: null, workspacePath: "/ws", titleOf });
    expect(list[0].subtitle).toBe("/ws/docs/sub");
    expect(list[1].subtitle).toBeNull();
    expect(list[1].title).toBe("未命名");
  });

  it("工作区外判定与 TabBar 同源（未命名 / 无工作区都不算工作区外）", () => {
    const tabs = [
      tab({ id: "in", path: "/ws/a.md" }),
      tab({ id: "out", path: "/other/a.md" }),
      tab({ id: "untitled", path: null }),
    ];
    const withWs = buildTabList(tabs, {
      activeTabId: null,
      workspacePath: "/ws",
      titleOf,
    });
    expect(withWs.map((e) => e.isOutOfWorkspace)).toEqual([false, true, false]);

    const noWs = buildTabList(tabs, { activeTabId: null, workspacePath: null, titleOf });
    expect(noWs.map((e) => e.isOutOfWorkspace)).toEqual([false, false, false]);
  });

  it("透传未保存标记", () => {
    const tabs = [tab({ id: "a", path: "/ws/a.md", isDirty: true })];
    const list = buildTabList(tabs, { activeTabId: null, workspacePath: "/ws", titleOf });
    expect(list[0].isDirty).toBe(true);
  });
});

describe("filterTabList", () => {
  const entries = buildTabList(
    [
      tab({ id: "1", path: "/ws/docs/intro.md" }),
      tab({ id: "2", path: "/ws/notes/api.md" }),
      tab({ id: "3", path: null }),
    ],
    { activeTabId: "2", workspacePath: "/ws", titleOf }
  );

  it("空查询返回全部（保持顺序）", () => {
    expect(filterTabList(entries, "").map((e) => e.id)).toEqual(["1", "2", "3"]);
    expect(filterTabList(entries, "   ").map((e) => e.id)).toEqual(["1", "2", "3"]);
  });

  it("按标题匹配且大小写不敏感", () => {
    expect(filterTabList(entries, "INTRO").map((e) => e.id)).toEqual(["1"]);
    expect(filterTabList(entries, "Api").map((e) => e.id)).toEqual(["2"]);
  });

  it("按所在目录匹配（这是「标签多且同名」时的主要定位手段）", () => {
    expect(filterTabList(entries, "notes").map((e) => e.id)).toEqual(["2"]);
    expect(filterTabList(entries, "docs").map((e) => e.id)).toEqual(["1"]);
  });

  it("未命名标签按注入的文案匹配", () => {
    expect(filterTabList(entries, "未命名").map((e) => e.id)).toEqual(["3"]);
  });

  it("无命中返回空数组", () => {
    expect(filterTabList(entries, "zzz")).toEqual([]);
  });
});
