import { describe, it, expect } from "vitest";
import { tabKeyAction } from "./tabNavigation";

// #386：标签栏键盘可达（roving tabindex）的纯逻辑层。
// TabBar.vue 的 keydown 处理只做三件事：取 action → preventDefault → 应用。
describe("tabKeyAction", () => {
  it("ArrowRight → 下一个标签", () => {
    expect(tabKeyAction("ArrowRight", 0, 3)).toEqual({
      nextIndex: 1,
      activate: false,
      close: false,
    });
  });

  it("ArrowRight 在最后一个 → 回绕到第一个", () => {
    expect(tabKeyAction("ArrowRight", 2, 3)).toEqual({
      nextIndex: 0,
      activate: false,
      close: false,
    });
  });

  it("ArrowLeft → 上一个标签", () => {
    expect(tabKeyAction("ArrowLeft", 2, 3)).toEqual({
      nextIndex: 1,
      activate: false,
      close: false,
    });
  });

  it("ArrowLeft 在第一个 → 回绕到最后一个", () => {
    expect(tabKeyAction("ArrowLeft", 0, 3)).toEqual({
      nextIndex: 2,
      activate: false,
      close: false,
    });
  });

  it("Home → 第一个", () => {
    expect(tabKeyAction("Home", 2, 3)).toEqual({
      nextIndex: 0,
      activate: false,
      close: false,
    });
  });

  it("End → 最后一个", () => {
    expect(tabKeyAction("End", 0, 3)).toEqual({
      nextIndex: 2,
      activate: false,
      close: false,
    });
  });

  it("Enter → 激活当前标签", () => {
    expect(tabKeyAction("Enter", 1, 3)).toEqual({
      nextIndex: 1,
      activate: true,
      close: false,
    });
  });

  it("Space → 激活当前标签", () => {
    expect(tabKeyAction(" ", 1, 3)).toEqual({
      nextIndex: 1,
      activate: true,
      close: false,
    });
  });

  it("Delete → 关闭当前标签", () => {
    expect(tabKeyAction("Delete", 1, 3)).toEqual({
      nextIndex: 1,
      activate: false,
      close: true,
    });
  });

  it("单标签时 ArrowRight 原位不动", () => {
    expect(tabKeyAction("ArrowRight", 0, 1)).toEqual({
      nextIndex: 0,
      activate: false,
      close: false,
    });
  });

  it("其它键 → null（不拦截，交给默认行为）", () => {
    expect(tabKeyAction("a", 0, 3)).toBeNull();
  });
});
