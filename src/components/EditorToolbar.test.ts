import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import EditorToolbar from "./EditorToolbar.vue";

/**
 * 创建附加到 jsdom 的 EditorView，供工具栏操作。
 */
function makeView(doc: string): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return new EditorView({
    state: EditorState.create({ doc }),
    parent: host,
  });
}

/**
 * 用简单 stub 隔离 naive-ui 组件，保证测试在 jsdom 中稳定。
 * NPopover stub 同时渲染 trigger 与默认 slot，使触发按钮可点击。
 */
const stubs = {
  NPopover: {
    name: "NPopover",
    template: '<div class="n-popover-stub"><slot name="trigger" /><slot /></div>',
  },
  NInput: { name: "NInput", template: '<input class="n-input-stub" />' },
  NButton: {
    name: "NButton",
    template: '<button class="n-button-stub"><slot /></button>',
  },
  NInputNumber: {
    name: "NInputNumber",
    template: '<input class="n-input-number-stub" type="number" />',
  },
  NSpace: { name: "NSpace", template: '<div class="n-space-stub"><slot /></div>' },
};

function makeToolbar(view: EditorView) {
  return mount(EditorToolbar, {
    props: { getView: () => view },
    global: { stubs },
  });
}

/** 按 title 属性查找按钮 */
function findByTitle(wrapper: ReturnType<typeof mount>, title: string) {
  return wrapper.find(`button[title="${title}"]`);
}

describe("EditorToolbar", () => {
  let view: EditorView;

  beforeEach(() => {
    view = makeView("hello world");
  });

  it("渲染所有分组按钮 + 分隔符", () => {
    const wrapper = makeToolbar(view);
    // 文本格式
    for (const t of ["加粗", "斜体", "删除线", "行内代码"]) {
      expect(findByTitle(wrapper, t).exists()).toBe(true);
    }
    // 标题
    for (const t of ["标题 1", "标题 2", "标题 3"]) {
      expect(findByTitle(wrapper, t).exists()).toBe(true);
    }
    // 列表/引用
    for (const t of ["无序列表", "有序列表", "任务列表", "引用"]) {
      expect(findByTitle(wrapper, t).exists()).toBe(true);
    }
    // 插入
    for (const t of ["插入链接", "插入图片", "插入表格", "代码块", "水平分隔线"]) {
      expect(findByTitle(wrapper, t).exists()).toBe(true);
    }
    // 分隔符
    expect(wrapper.findAll(".tb-sep").length).toBe(4);
  });

  it("根容器具备 role=toolbar", () => {
    const wrapper = makeToolbar(view);
    expect(wrapper.find(".editor-toolbar").attributes("role")).toBe("toolbar");
  });

  it("点击加粗 → 选区被 ** 包围", async () => {
    // 选中 "hello"
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    const wrapper = makeToolbar(view);
    await findByTitle(wrapper, "加粗").trigger("click");
    expect(view.state.doc.toString()).toBe("**hello** world");
  });

  it("点击斜体 → 选区被 * 包围", async () => {
    view.dispatch({ selection: { anchor: 6, head: 11 } });
    const wrapper = makeToolbar(view);
    await findByTitle(wrapper, "斜体").trigger("click");
    expect(view.state.doc.toString()).toBe("hello *world*");
  });

  it("点击行内代码 → 选区被 ` 包围", async () => {
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    const wrapper = makeToolbar(view);
    await findByTitle(wrapper, "行内代码").trigger("click");
    expect(view.state.doc.toString()).toBe("`hello` world");
  });

  it("点击删除线 → 选区被 ~~ 包围", async () => {
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    const wrapper = makeToolbar(view);
    await findByTitle(wrapper, "删除线").trigger("click");
    expect(view.state.doc.toString()).toBe("~~hello~~ world");
  });

  it("再次点击加粗 → 移除 ** 标记（toggle）", async () => {
    view = makeView("**hello** world");
    view.dispatch({ selection: { anchor: 0, head: 9 } });
    const wrapper = makeToolbar(view);
    await findByTitle(wrapper, "加粗").trigger("click");
    expect(view.state.doc.toString()).toBe("hello world");
  });

  it("点击标题 1 → 当前行添加 # 前缀", async () => {
    view.dispatch({ selection: { anchor: 0 } });
    const wrapper = makeToolbar(view);
    await findByTitle(wrapper, "标题 1").trigger("click");
    expect(view.state.doc.toString()).toBe("# hello world");
  });

  it("点击标题 2 → 当前行添加 ## 前缀", async () => {
    view.dispatch({ selection: { anchor: 0 } });
    const wrapper = makeToolbar(view);
    await findByTitle(wrapper, "标题 2").trigger("click");
    expect(view.state.doc.toString()).toBe("## hello world");
  });

  it("点击无序列表 → 当前行添加 - 前缀", async () => {
    view.dispatch({ selection: { anchor: 0 } });
    const wrapper = makeToolbar(view);
    await findByTitle(wrapper, "无序列表").trigger("click");
    expect(view.state.doc.toString()).toBe("- hello world");
  });

  it("点击有序列表 → 当前行添加 1. 前缀", async () => {
    view.dispatch({ selection: { anchor: 0 } });
    const wrapper = makeToolbar(view);
    await findByTitle(wrapper, "有序列表").trigger("click");
    expect(view.state.doc.toString()).toBe("1. hello world");
  });

  it("点击任务列表 → 当前行添加 - [ ] 前缀", async () => {
    view.dispatch({ selection: { anchor: 0 } });
    const wrapper = makeToolbar(view);
    await findByTitle(wrapper, "任务列表").trigger("click");
    expect(view.state.doc.toString()).toBe("- [ ] hello world");
  });

  it("点击引用 → 当前行添加 > 前缀", async () => {
    view.dispatch({ selection: { anchor: 0 } });
    const wrapper = makeToolbar(view);
    await findByTitle(wrapper, "引用").trigger("click");
    expect(view.state.doc.toString()).toBe("> hello world");
  });

  it("点击水平分隔线 → 插入 ---", async () => {
    view = makeView("line1\nline2");
    view.dispatch({ selection: { anchor: 0 } });
    const wrapper = makeToolbar(view);
    await findByTitle(wrapper, "水平分隔线").trigger("click");
    expect(view.state.doc.toString()).toContain("---");
  });

  it("点击代码块 → 用 ``` 包裹选区", async () => {
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    const wrapper = makeToolbar(view);
    await findByTitle(wrapper, "代码块").trigger("click");
    expect(view.state.doc.toString()).toContain("```");
    expect(view.state.doc.toString()).toContain("hello");
  });

  describe("激活态", () => {
    it("光标在 **bold** 内 → 加粗按钮高亮", () => {
      view = makeView("**bold** text");
      view.dispatch({ selection: { anchor: 3 } });
      const wrapper = makeToolbar(view);
      const btn = findByTitle(wrapper, "加粗");
      expect(btn.classes()).toContain("active");
      expect(btn.attributes("aria-pressed")).toBe("true");
    });

    it("光标在 *italic* 内 → 斜体按钮高亮", () => {
      view = makeView("*italic* text");
      view.dispatch({ selection: { anchor: 3 } });
      const wrapper = makeToolbar(view);
      expect(findByTitle(wrapper, "斜体").classes()).toContain("active");
    });

    it("光标在 `code` 内 → 行内代码按钮高亮", () => {
      view = makeView("`code` text");
      view.dispatch({ selection: { anchor: 3 } });
      const wrapper = makeToolbar(view);
      expect(findByTitle(wrapper, "行内代码").classes()).toContain("active");
    });

    it("光标在 ## 标题行 → 标题 2 按钮高亮", () => {
      view = makeView("## title\nbody");
      view.dispatch({ selection: { anchor: 3 } });
      const wrapper = makeToolbar(view);
      expect(findByTitle(wrapper, "标题 2").classes()).toContain("active");
      expect(findByTitle(wrapper, "标题 1").classes()).not.toContain("active");
    });

    it("光标在 - 列表行 → 无序列表按钮高亮", () => {
      view = makeView("- item");
      view.dispatch({ selection: { anchor: 3 } });
      const wrapper = makeToolbar(view);
      expect(findByTitle(wrapper, "无序列表").classes()).toContain("active");
    });

    it("光标在 > 引用行 → 引用按钮高亮", () => {
      view = makeView("> quote");
      view.dispatch({ selection: { anchor: 3 } });
      const wrapper = makeToolbar(view);
      expect(findByTitle(wrapper, "引用").classes()).toContain("active");
    });

    it("cursorKey 变化时刷新激活态", async () => {
      view = makeView("plain text");
      const wrapper = makeToolbar(view);
      expect(findByTitle(wrapper, "加粗").classes()).not.toContain("active");
      // 模拟切换到含 bold 的文档并移动光标
      view.dispatch({
        changes: { from: 0, to: 10, insert: "**bold** text" },
      });
      view.dispatch({ selection: { anchor: 3 } });
      await wrapper.setProps({ cursorKey: 1 });
      await nextTick();
      expect(findByTitle(wrapper, "加粗").classes()).toContain("active");
    });
  });

  describe("浮层触发按钮", () => {
    it("链接/图片/表格触发按钮均渲染", () => {
      const wrapper = makeToolbar(view);
      expect(findByTitle(wrapper, "插入链接").exists()).toBe(true);
      expect(findByTitle(wrapper, "插入图片").exists()).toBe(true);
      expect(findByTitle(wrapper, "插入表格").exists()).toBe(true);
    });
  });

  it("getView 返回 null 时不抛错", () => {
    const wrapper = mount(EditorToolbar, {
      props: { getView: () => null },
      global: { stubs },
    });
    expect(wrapper.find(".editor-toolbar").exists()).toBe(true);
  });
});
