import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia, getActivePinia } from "pinia";
import TabBar from "./TabBar.vue";
import { i18n } from "../i18n";
import { useTabsStore } from "../stores/useTabsStore";

/**
 * 用 stub 隔离 naive-ui 组件，保证测试在 jsdom 中稳定。
 * NPopover stub 同时渲染 trigger 与默认 slot。
 */
const stubs = {
  NPopover: {
    name: "NPopover",
    template: '<div class="n-popover-stub"><slot name="trigger" /><slot /></div>',
  },
  NScrollbar: {
    name: "NScrollbar",
    template: '<div class="n-scrollbar-stub"><slot /></div>',
  },
};

/** 挂载前先建 pinia 并预置 tab——mount 复用同一 active pinia，避免数据落空 */
function mountTabBar(tabs = 1): ReturnType<typeof mount> {
  setActivePinia(createPinia());
  const store = useTabsStore();
  for (let i = 0; i < tabs; i++) store.newTab();
  return mount(TabBar, {
    props: { allTabsOpen: false },
    global: { plugins: [getActivePinia()!, i18n], stubs },
  });
}

describe("TabBar", () => {
  describe("#386 WAI-ARIA tabs 模式", () => {
    it("关闭按钮不可 Tab 聚焦（tab 不得含可聚焦后代）", () => {
      const wrapper = mountTabBar(1);
      const closeBtn = wrapper.find(".tab-item .close-btn");
      expect(closeBtn.exists()).toBe(true);
      expect(closeBtn.attributes("tabindex")).toBe("-1");
    });

    it("tab 项遵循 roving tabindex：激活项 0、非激活项 -1", () => {
      const wrapper = mountTabBar(2);
      const items = wrapper.findAll(".tab-item");
      expect(items).toHaveLength(2);
      const activeIdx = items.findIndex((w) => w.classes().includes("active"));
      expect(activeIdx).toBeGreaterThanOrEqual(0);
      expect(items[activeIdx].attributes("tabindex")).toBe("0");
      expect(items[1 - activeIdx].attributes("tabindex")).toBe("-1");
    });
  });
});
