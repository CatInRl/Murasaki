import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { FileX } from "lucide-vue-next";
import ErrorState from "./ErrorState.vue";

describe("ErrorState", () => {
  it("默认渲染 AlertTriangle 图标与标题", () => {
    const wrapper = mount(ErrorState, {
      props: { title: "加载失败" },
    });
    expect(wrapper.text()).toContain("加载失败");
    expect(wrapper.find(".error-icon").exists()).toBe(true);
    expect(wrapper.find(".error-retry").text()).toBe("重试");
  });

  it("渲染描述文字", () => {
    const wrapper = mount(ErrorState, {
      props: { title: "失败", description: "请检查网络" },
    });
    expect(wrapper.text()).toContain("请检查网络");
  });

  it("未提供 description 时不渲染描述段落", () => {
    const wrapper = mount(ErrorState, {
      props: { title: "失败" },
    });
    expect(wrapper.find(".error-description").exists()).toBe(false);
  });

  it("可自定义图标", () => {
    const wrapper = mount(ErrorState, {
      props: { icon: FileX, title: "文件丢失" },
    });
    expect(wrapper.find(".error-icon").exists()).toBe(true);
    expect(wrapper.find(".error-state svg").exists()).toBe(true);
  });

  it("可自定义 retryText", () => {
    const wrapper = mount(ErrorState, {
      props: { title: "失败", retryText: "重新加载" },
    });
    expect(wrapper.find(".error-retry").text()).toBe("重新加载");
  });

  it("点击重试按钮 emits retry", async () => {
    const wrapper = mount(ErrorState, {
      props: { title: "失败" },
    });
    await wrapper.find(".error-retry").trigger("click");
    expect(wrapper.emitted("retry")).toBeTruthy();
    expect(wrapper.emitted("retry")!.length).toBe(1);
  });

  it("根容器具备 role=alert 与 aria-live=assertive", () => {
    const wrapper = mount(ErrorState, {
      props: { title: "失败" },
    });
    const root = wrapper.find(".error-state");
    expect(root.attributes("role")).toBe("alert");
    expect(root.attributes("aria-live")).toBe("assertive");
  });
});
