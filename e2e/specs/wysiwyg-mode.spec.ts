/**
 * WYSIWYG 模式 E2E 测试（Ticket #72-77 / T7.1-T7.4）
 *
 * 验证：
 * - 三种编辑模式（source/split/wysiwyg）切换
 * - source/split 模式无预览区差异
 * - wysiwyg 模式隐藏预览区
 * - 编辑器工具栏（EditorToolbar）在所有模式可见
 * - wysiwyg 模式下 Markdown 标记隐藏
 *
 * 通过 Pinia store 切换 editorMode，验证 UI 渲染。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace, defaultFixtureFiles } from "../helpers/fixtures";
import { openWorkspace, closeWorkspace, openFileInTab, closeAllTabs, waitForPinia } from "../helpers/store";

let browser: Browser;

describe("WYSIWYG 模式切换", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  beforeEach(async () => {
    try { await closeAllTabs(browser); } catch { /* ignore */ }
    try { await closeWorkspace(browser); } catch { /* ignore */ }
  });

  it("默认 split 模式显示预览区", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    // 等待编辑器渲染
    const editorPane = await browser.$(".editor-pane");
    await editorPane.waitForExist({ timeout: 10000 });

    // 默认应为 split 模式
    const modeClass = await editorPane.getAttribute("class");
    expect(modeClass).toContain("mode-split");

    // split 模式应显示预览区
    const preview = await browser.$(".pane-right .preview-pane, .pane-right");
    expect(await preview.isExisting()).toBe(true);
  });

  it("切换到 source 模式隐藏预览区", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    // 切换到 source 模式
    await browser.execute(() => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const editorBridge = pinia._s.get("editorBridge");
      editorBridge.setEditorMode("source");
    });

    await browser.pause(500);

    const editorPane = await browser.$(".editor-pane");
    const modeClass = await editorPane.getAttribute("class");
    expect(modeClass).toContain("mode-source");

    // source 模式不应显示预览区
    const preview = await browser.$(".pane-right");
    expect(await preview.isExisting()).toBe(false);
  });

  it("切换到 wysiwyg 模式隐藏预览区", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    // 切换到 wysiwyg 模式
    await browser.execute(() => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const editorBridge = pinia._s.get("editorBridge");
      editorBridge.setEditorMode("wysiwyg");
    });

    await browser.pause(500);

    const editorPane = await browser.$(".editor-pane");
    const modeClass = await editorPane.getAttribute("class");
    expect(modeClass).toContain("mode-wysiwyg");

    // wysiwyg 模式不应显示预览区
    const preview = await browser.$(".pane-right");
    expect(await preview.isExisting()).toBe(false);
  });

  it("编辑器工具栏在所有模式可见", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    // 等待工具栏渲染
    const toolbar = await browser.$(".editor-toolbar");
    await toolbar.waitForExist({ timeout: 10000 });
    expect(await toolbar.isDisplayed()).toBe(true);

    // 切换到 source 模式
    await browser.execute(() => {
      // @ts-ignore
      const editorBridge = window.__pinia__._s.get("editorBridge");
      editorBridge.setEditorMode("source");
    });
    await browser.pause(300);
    expect(await toolbar.isDisplayed()).toBe(true);

    // 切换到 wysiwyg 模式
    await browser.execute(() => {
      // @ts-ignore
      const editorBridge = window.__pinia__._s.get("editorBridge");
      editorBridge.setEditorMode("wysiwyg");
    });
    await browser.pause(300);
    expect(await toolbar.isDisplayed()).toBe(true);
  });

  it("wysiwyg 模式下标题标记被隐藏", async () => {
    // 准备含标题 + 正文两段的 markdown（光标需移到标题段之外才能触发 hide）
    const wsPath = resetWorkspace([
      { path: "heading.md", content: "# 大标题\n\n正文内容\n" },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\heading.md`);

    // 先切到 source 模式，确认 # 标记可见
    await browser.execute(() => {
      // @ts-ignore
      const editorBridge = window.__pinia__._s.get("editorBridge");
      editorBridge.setEditorMode("source");
    });
    await browser.pause(300);

    // 切到 wysiwyg 模式
    await browser.execute(() => {
      // @ts-ignore
      const editorBridge = window.__pinia__._s.get("editorBridge");
      editorBridge.setEditorMode("wysiwyg");
    });
    await browser.pause(500);

    // 移动光标到正文段（position 7 = "正"之前），使标题段脱离光标所在段落
    // "# 大标题\n\n正文内容\n" 中 position 7 是 "正"
    await browser.execute(() => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const editorBridge = pinia._s.get("editorBridge");
      const view = editorBridge.editorView;
      if (view) {
        view.dispatch({
          selection: { anchor: 7, head: 7 },
          scrollIntoView: false,
        });
        view.focus();
      }
    });
    // 等待 debounce (50ms) + recompute + render
    await browser.pause(600);

    // 诊断：检查 editorView 状态和装饰
    const diag = await browser.execute(() => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const editorBridge = pinia._s.get("editorBridge");
      const view = editorBridge.editorView;
      if (!view) return { error: "no editorView" };
      const state = view.state;
      // 检查 DOM 中的 hide 元素
      const hideEls = view.dom.querySelectorAll(".murasaki-wysiwyg-mark-hide");
      const dimEls = view.dom.querySelectorAll(".murasaki-wysiwyg-mark-dim");
      return {
        cursorPos: state.selection.main.head,
        docLength: state.doc.length,
        docText: state.doc.toString().substring(0, 50),
        hideCount: hideEls.length,
        dimCount: dimEls.length,
        editorMode: editorBridge.editorMode,
      };
    });
    console.log("[diag] wysiwyg heading:", JSON.stringify(diag));

    // wysiwyg 模式下应有 hide decoration 的 CSS 类
    const hiddenMarks = await browser.$$(".murasaki-wysiwyg-mark-hide");
    // 光标不在标题行时，# 标记应被隐藏
    expect(hiddenMarks.length).toBeGreaterThan(0);
  });

  it("wysiwyg 模式下列表 bullet 替换为 widget", async () => {
    // 列表后加正文段，光标移到正文段后，列表标记才不在光标段落内 → 替换为 bullet
    const wsPath = resetWorkspace([
      { path: "list.md", content: "- 项目一\n- 项目二\n- 项目三\n\n正文\n" },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\list.md`);

    // 切到 wysiwyg 模式
    await browser.execute(() => {
      // @ts-ignore
      const editorBridge = window.__pinia__._s.get("editorBridge");
      editorBridge.setEditorMode("wysiwyg");
    });
    await browser.pause(300);

    // 移动光标到正文段（position 22 = "正"之前），使列表段脱离光标所在段落
    // "- 项目一\n- 项目二\n- 项目三\n\n" = 22 chars
    await browser.execute(() => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const editorBridge = pinia._s.get("editorBridge");
      const view = editorBridge.editorView;
      if (view) {
        view.dispatch({
          selection: { anchor: 22, head: 22 },
          scrollIntoView: false,
        });
        view.focus();
      }
    });
    await browser.pause(400);

    // 应有 bullet widget（• 替换 -/*/+ 标记）
    const bullets = await browser.$$(".murasaki-wysiwyg-bullet");
    expect(bullets.length).toBeGreaterThanOrEqual(1);
  });

  it("source → wysiwyg → split 循环切换正常", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    const editorPane = await browser.$(".editor-pane");
    await editorPane.waitForExist({ timeout: 10000 });

    // source
    await browser.execute(() => {
      // @ts-ignore
      const editorBridge = window.__pinia__._s.get("editorBridge");
      editorBridge.setEditorMode("source");
    });
    await browser.pause(300);
    expect(await editorPane.getAttribute("class")).toContain("mode-source");

    // wysiwyg
    await browser.execute(() => {
      // @ts-ignore
      const editorBridge = window.__pinia__._s.get("editorBridge");
      editorBridge.setEditorMode("wysiwyg");
    });
    await browser.pause(300);
    expect(await editorPane.getAttribute("class")).toContain("mode-wysiwyg");

    // split
    await browser.execute(() => {
      // @ts-ignore
      const editorBridge = window.__pinia__._s.get("editorBridge");
      editorBridge.setEditorMode("split");
    });
    await browser.pause(300);
    expect(await editorPane.getAttribute("class")).toContain("mode-split");

    // split 模式应恢复预览区
    const preview = await browser.$(".pane-right");
    expect(await preview.isExisting()).toBe(true);
  });
});
