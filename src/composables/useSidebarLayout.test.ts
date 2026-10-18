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
});
