import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { FileText } from "lucide-vue-next";
import EmptyState from "./EmptyState.vue";

describe("EmptyState", () => {
  it("渲染图标 + 标题 + 描述", () => {
    const wrapper = mount(EmptyState, {
      props: { icon: FileText, title: "暂无文件", description: "新建一个开始" },
    });
    expect(wrapper.text()).toContain("暂无文件");
    expect(wrapper.text()).toContain("新建一个开始");
    expect(wrapper.find(".empty-icon").exists()).toBe(true);
  });

  it("未提供 description 时不渲染描述段落", () => {
    const wrapper = mount(EmptyState, {
      props: { icon: FileText, title: "空" },
    });
    expect(wrapper.find(".empty-description").exists()).toBe(false);
  });

  it("未提供 actionText 时不渲染操作按钮", () => {
    const wrapper = mount(EmptyState, {
      props: { icon: FileText, title: "空" },
    });
    expect(wrapper.find(".empty-action").exists()).toBe(false);
  });

  it("提供 actionText 时渲染按钮并 emits action", async () => {
    const wrapper = mount(EmptyState, {
      props: { icon: FileText, title: "空", actionText: "新建" },
    });
    const btn = wrapper.find(".empty-action");
    expect(btn.exists()).toBe(true);
    expect(btn.text()).toContain("新建");
    await btn.trigger("click");
    expect(wrapper.emitted("action")).toBeTruthy();
    expect(wrapper.emitted("action")!.length).toBe(1);
  });

  it("提供 actionIcon 时在按钮中渲染图标", () => {
    const wrapper = mount(EmptyState, {
      props: {
        icon: FileText,
        title: "空",
        actionText: "新建",
        actionIcon: FileText,
      },
    });
    expect(wrapper.find(".empty-action").findAll("svg")).toHaveLength(1);
  });

  it("根容器具备 role=status 与 aria-live=polite", () => {
    const wrapper = mount(EmptyState, {
      props: { icon: FileText, title: "空" },
    });
    const root = wrapper.find(".empty-state");
    expect(root.attributes("role")).toBe("status");
    expect(root.attributes("aria-live")).toBe("polite");
  });
});
