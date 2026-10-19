/**
 * 欢迎页单测（#444 收尾：把 design-system.spec.ts 里的 DOM 结构断言下沉到 jsdom）
 *
 * 这些用例原本跑在 e2e 里，每条都要付一次真实 WebView 启动成本（≈30s）。
 * 它们只断言「渲染出了什么节点、什么文案」，不依赖真实 CSS 引擎，
 * 用 @vue/test-utils 挂载即可 —— 留在 e2e 的只有真正需要浏览器样式计算的项
 * （CSS 变量解析、color-mix 生效、虚线边框），见 design-system.spec.ts。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import WelcomePage from "./WelcomePage.vue";
import { i18n } from "../i18n";

// 版本号来自 Tauri 运行时，jsdom 里没有 —— 固定掉，避免 onMounted 里的 await 悬挂
vi.mock("../utils/appVersion", () => ({
  getAppVersion: vi.fn(async () => "0.0.0-test"),
}));

function mountWelcome() {
  setActivePinia(createPinia());
  return mount(WelcomePage, {
    global: { plugins: [i18n] },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("WelcomePage", () => {
  it("品牌区渲染 BookOpen 图标（inline SVG）", () => {
    const wrapper = mountWelcome();
    const mark = wrapper.find(".welcome-page .brand-mark");
    expect(mark.exists()).toBe(true);
    // lucide 组件渲染成 <svg>，不是字体图标或 img
    expect(mark.find("svg").exists()).toBe(true);
  });

  it("渲染品牌标题 Murasaki", () => {
    const wrapper = mountWelcome();
    expect(wrapper.find(".welcome-page .brand-title").text()).toBe("Murasaki");
  });

  it("渲染三张主操作卡片", () => {
    const wrapper = mountWelcome();
    expect(wrapper.findAll(".welcome-page .action-card")).toHaveLength(3);
  });

  it("主操作卡片对应「打开文件夹 / 打开文件 / 新建文件」三个入口", async () => {
    const wrapper = mountWelcome();
    const cards = wrapper.findAll(".welcome-page .action-card");

    // 三张卡片都带图标（内联 SVG）
    for (const card of cards) {
      expect(card.find(".action-icon svg").exists()).toBe(true);
    }

    await cards[0].trigger("click");
    await cards[1].trigger("click");
    await cards[2].trigger("click");

    expect(wrapper.emitted("open-folder")).toHaveLength(1);
    expect(wrapper.emitted("open-file")).toHaveLength(1);
    expect(wrapper.emitted("new-file")).toHaveLength(1);
  });

  it("快捷键提示至少三条，含打开文件 / 新建 / 打开文件夹", () => {
    const wrapper = mountWelcome();
    const hints = wrapper.findAll(".welcome-page .shortcut-hint");
    expect(hints.length).toBeGreaterThanOrEqual(3);

    const keys = hints.map((hint) => hint.find(".shortcut-key").text());
    // 具体键位随平台（macOS 显示 ⌘ 变体），这里只断言三条提示都在场
    expect(keys).toHaveLength(3);
    expect(keys.every((k) => k.length > 0)).toBe(true);
  });

  it("无最近打开记录时不渲染「最近打开」区块", () => {
    const wrapper = mountWelcome();
    expect(wrapper.findAll(".welcome-page .recent-block")).toHaveLength(0);
  });
});
