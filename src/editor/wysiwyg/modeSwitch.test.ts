/**
 * WYSIWYG 模式切换测试（issue #115）
 *
 * 验证：从 source/split 模式切换到 wysiwyg 模式时，装饰正确应用。
 * 模拟 SourceEditor.vue 的 wysiwygComp.reconfigure 路径。
 */
import { describe, it, expect, afterEach } from "vitest";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { wysiwygExtensions } from "./wysiwygPlugin";

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

describe("模式切换：source/split → wysiwyg", () => {
  it("reconfigure 后行内标记被隐藏（mark-hide）", () => {
    const doc = "# 标题\n\n**bold**\n\n正文";
    const wysiwygComp = new Compartment();

    // 初始：source 模式（wysiwygComp 为空）
    const initialState = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        wysiwygComp.of([]),
      ],
    });
    ensureSyntaxTree(initialState, doc.length + 1);
    view = new EditorView({ state: initialState });

    // 切换前：不应有 WYSIWYG 装饰
    expect(view.dom.querySelector(".murasaki-wysiwyg-mark-hide")).toBeFalsy();

    // 切换到 wysiwyg 模式
    view.dispatch({
      effects: wysiwygComp.reconfigure(wysiwygExtensions),
    });

    // 光标在文档末尾（"正文"段），**bold** 段离开当前段 → EmphasisMark 应被隐藏
    // # 标题 的 HeaderMark 也应被隐藏
    const hideCount = view.dom.querySelectorAll(".murasaki-wysiwyg-mark-hide").length;
    expect(hideCount).toBeGreaterThanOrEqual(1);
  });

  it("reconfigure 后代码块被替换为 widget", () => {
    const doc = "intro\n\n```js\nconst x = 1;\n```\n\ntail";
    const wysiwygComp = new Compartment();

    const initialState = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        wysiwygComp.of([]),
      ],
    });
    ensureSyntaxTree(initialState, doc.length + 1);
    view = new EditorView({ state: initialState });

    // 切换前：无代码块 widget
    expect(view.dom.querySelector(".murasaki-wysiwyg-codeblock-wrapper")).toBeFalsy();

    // 切换到 wysiwyg 模式（光标在末尾 "tail" 段，代码块离开当前段）
    view.dispatch({
      effects: wysiwygComp.reconfigure(wysiwygExtensions),
    });

    // 代码块应被替换为 widget
    expect(view.dom.querySelector(".murasaki-wysiwyg-codeblock-wrapper")).toBeTruthy();
  });

  it("reconfigure 后无序列表标记被替换为 bullet widget（光标离开列表段）", () => {
    const doc = "- item one\n- item two\n\ntail";
    const wysiwygComp = new Compartment();

    // 光标放在 "tail" 段（离开列表段）→ 列表标记应被替换为 bullet widget
    const initialState = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        wysiwygComp.of([]),
      ],
    });
    ensureSyntaxTree(initialState, doc.length + 1);
    // 设置光标到 "tail" 位置
    const stateWithCursor = initialState.update({
      selection: { anchor: doc.indexOf("tail") },
    }).state;
    view = new EditorView({ state: stateWithCursor });

    expect(view.dom.querySelector(".murasaki-wysiwyg-bullet")).toBeFalsy();

    view.dispatch({
      effects: wysiwygComp.reconfigure(wysiwygExtensions),
    });

    expect(view.dom.querySelector(".murasaki-wysiwyg-bullet")).toBeTruthy();
  });
});

/**
 * 初始挂载场景：应用以 wysiwyg 模式启动（从持久化设置恢复）。
 * wysiwygExtensions 从一开始就包含在 state 中（非 reconfigure 路径）。
 * 验证 wysiwygField.create() 在初始状态创建时能正确计算装饰。
 */
describe("初始挂载：wysiwyg 模式（非 reconfigure）", () => {
  it("初始 state 含 wysiwygExtensions → 装饰正确应用", () => {
    const doc = "# 标题\n\n**bold**\n\n```js\ncode\n```\n\ntail";

    // 不预先调用 ensureSyntaxTree —— 模拟真实 SourceEditor onMounted 路径
    // 小文档在 EditorState.create 时由 markdown parser 同步解析完成
    const state = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        ...wysiwygExtensions,
      ],
    });
    // 光标放到 "tail" 段（离开标题/bold/code 段）
    const stateWithCursor = state.update({
      selection: { anchor: doc.indexOf("tail") },
    }).state;
    view = new EditorView({ state: stateWithCursor });

    // 行内标记隐藏
    const hideCount = view.dom.querySelectorAll(".murasaki-wysiwyg-mark-hide").length;
    expect(hideCount).toBeGreaterThanOrEqual(1);
    // 代码块 widget
    expect(view.dom.querySelector(".murasaki-wysiwyg-codeblock-wrapper")).toBeTruthy();
  });
});

/**
 * Tab 切换场景（issue #115 核心修复）：
 * 在 split 模式下缓存了 tab state，切换到 wysiwyg 模式后切回该 tab，
 * setState 恢复的 cached state 的 wysiwygComp 仍为 []（split 配置）。
 * 修复：setState 后 reconfigure wysiwygComp 匹配当前 editorMode。
 */
describe("Tab 切换：cached state 的 wysiwygComp 不匹配当前模式", () => {
  it("setState 后 reconfigure → 装饰正确应用", () => {
    const doc = "# 标题\n\n**bold**\n\ntail";
    const wysiwygComp = new Compartment();

    // 1. 初始：split 模式（wysiwygComp 为空），光标在 "tail" 段
    const initialState = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        wysiwygComp.of([]),
      ],
    });
    ensureSyntaxTree(initialState, doc.length + 1);
    const stateWithCursor = initialState.update({
      selection: { anchor: doc.indexOf("tail") },
    }).state;
    view = new EditorView({ state: stateWithCursor });

    // 2. 切换到 wysiwyg 模式 → 装饰应用
    view.dispatch({ effects: wysiwygComp.reconfigure(wysiwygExtensions) });
    expect(view.dom.querySelectorAll(".murasaki-wysiwyg-mark-hide").length).toBeGreaterThanOrEqual(1);

    // 3. 模拟切走再切回：保存当前 state（含 wysiwygExtensions），然后模拟
    //    另一个 tab 的 cached state（wysiwygComp=[]，split 模式时缓存的）
    const splitCachedState = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        wysiwygComp.of([]),  // split 模式缓存
      ],
    });
    ensureSyntaxTree(splitCachedState, doc.length + 1);
    const splitCachedWithCursor = splitCachedState.update({
      selection: { anchor: doc.indexOf("tail") },
    }).state;

    // 4. setState 恢复 cached state（split 配置）→ 装饰消失
    view.setState(splitCachedWithCursor);
    expect(view.dom.querySelector(".murasaki-wysiwyg-mark-hide")).toBeFalsy();

    // 5. 修复：reconfigure wysiwygComp 匹配当前 wysiwyg 模式
    view.dispatch({
      effects: wysiwygComp.reconfigure(wysiwygExtensions),
    });

    // 6. 装饰重新应用
    expect(view.dom.querySelectorAll(".murasaki-wysiwyg-mark-hide").length).toBeGreaterThanOrEqual(1);
  });
});
