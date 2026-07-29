import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { File } from "lucide-vue-next";
import Skeleton from "./Skeleton.vue";

describe("Skeleton", () => {
  it("默认渲染 4 行骨架条", () => {
    const wrapper = mount(Skeleton);
    expect(wrapper.findAll(".skeleton-row")).toHaveLength(4);
    expect(wrapper.findAll(".skeleton-bar")).toHaveLength(4);
  });

  it("可指定行数", () => {
    const wrapper = mount(Skeleton, { props: { lines: 6 } });
    expect(wrapper.findAll(".skeleton-row")).toHaveLength(6);
  });

  it("根容器具备 role=status / aria-busy=true", () => {
    const wrapper = mount(Skeleton);
    const root = wrapper.find(".skeleton");
    expect(root.attributes("role")).toBe("status");
    expect(root.attributes("aria-busy")).toBe("true");
    expect(root.attributes("aria-live")).toBe("polite");
  });

  it("宽度按 100/90/95/70 循环", () => {
    const wrapper = mount(Skeleton, { props: { lines: 4 } });
    const bars = wrapper.findAll(".skeleton-bar");
    expect(bars[0].attributes("style")).toContain("width: 100%");
    expect(bars[1].attributes("style")).toContain("width: 90%");
    expect(bars[2].attributes("style")).toContain("width: 95%");
    expect(bars[3].attributes("style")).toContain("width: 70%");
  });

  it("超过 4 行后宽度模式循环", () => {
    const wrapper = mount(Skeleton, { props: { lines: 5 } });
    const bars = wrapper.findAll(".skeleton-bar");
    expect(bars[4].attributes("style")).toContain("width: 100%");
  });

  it("提供 icon 时每行渲染图标", () => {
    const wrapper = mount(Skeleton, { props: { lines: 2, icon: File } });
    expect(wrapper.findAll(".skeleton-icon")).toHaveLength(2);
  });

  it("未提供 icon 时不渲染图标", () => {
    const wrapper = mount(Skeleton);
    expect(wrapper.find(".skeleton-icon").exists()).toBe(false);
  });
});
