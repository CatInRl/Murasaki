import { describe, it, expect, vi } from "vitest";
import { nextTick, ref } from "vue";
import {
  useSidebarLayout,
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "./useSidebarLayout";

/**
 * #433：侧栏布局（宽度 / 折叠 / 拖拽 / 持久化）。
 */
function setup(initializedValue = false) {
  const initialized = ref(initializedValue);
  const updateSettings = vi.fn(async () => undefined);
  const layout = useSidebarLayout({ initialized, updateSettings });
  return { initialized, updateSettings, layout };
}

describe("useSidebarLayout", () => {
  it("折叠时宽度固定为细条，展开时用用户宽度", () => {
    const { layout } = setup();
    layout.width.value = 320;
    expect(layout.style.value).toEqual({ width: "320px" });

    layout.collapse();
    expect(layout.style.value).toEqual({ width: `${SIDEBAR_COLLAPSED_WIDTH}px` });

    layout.expand();
    expect(layout.style.value).toEqual({ width: "320px" });
  });

  it("restore 会把越界宽度夹到上下限", () => {
    const { layout } = setup();

    layout.restore({ width: 10, collapsed: false });
    expect(layout.width.value).toBe(SIDEBAR_MIN_WIDTH);

    layout.restore({ width: 9999, collapsed: true });
    expect(layout.width.value).toBe(SIDEBAR_MAX_WIDTH);
    expect(layout.collapsed.value).toBe(true);
  });

  it("初始化完成前不写回设置，完成后才持久化", async () => {
    const { initialized, updateSettings, layout } = setup(false);

    layout.width.value = 300;
    await nextTick();
    expect(updateSettings).not.toHaveBeenCalled();

    initialized.value = true;
    layout.collapse();
    await nextTick();
    expect(updateSettings).toHaveBeenCalledWith({ sidebarCollapsed: true });

    layout.width.value = 280;
    await nextTick();
    expect(updateSettings).toHaveBeenCalledWith({ sidebarWidth: 280 });
  });

  it("拖拽调宽会夹在上下限内，并在 pointerup 后复位状态", () => {
    const { layout } = setup();
    layout.width.value = 300;
    const el = document.createElement("div");
    el.setPointerCapture = vi.fn();

    layout.startResize({
      currentTarget: el,
      clientX: 100,
      pointerId: 1,
      preventDefault: vi.fn(),
    } as unknown as PointerEvent);
    expect(layout.dragging.value).toBe(true);
    expect(document.body.style.userSelect).toBe("none");

    // 向右拖到超上限
    window.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 900 }));
    expect(layout.width.value).toBe(SIDEBAR_MAX_WIDTH);

    // 向左拖到超下限
    window.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: -900 }));
    expect(layout.width.value).toBe(SIDEBAR_MIN_WIDTH);

    window.dispatchEvent(new Event("pointerup"));
    expect(layout.dragging.value).toBe(false);
    expect(document.body.style.userSelect).toBe("");
  });

  it("折叠状态下不允许拖拽", () => {
    const { layout } = setup();
    layout.collapse();

    layout.startResize({
      currentTarget: document.createElement("div"),
      clientX: 100,
      pointerId: 1,
      preventDefault: vi.fn(),
    } as unknown as PointerEvent);

    expect(layout.dragging.value).toBe(false);
  });
});
