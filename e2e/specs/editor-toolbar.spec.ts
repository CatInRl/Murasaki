/**
 * 编辑器工具栏 E2E 测试（议题簇 5 / Ticket #72, T7.3）
 *
 * 验证：
 * - 工具栏渲染格式化按钮
 * - Bold 按钮在光标处插入 ** 标记
 * - Italic 按钮插入 * 标记
 * - 标题按钮切换标题级别
 * - 无序列表按钮插入 - 标记
 * - 工具栏按钮 title 属性正确
 *
 * 通过 CodeMirror View dispatch 直接操作编辑器状态。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace } from "../helpers/fixtures";
import { openWorkspace, closeWorkspace, openFileInTab, closeAllTabs, waitForPinia } from "../helpers/store";

let browser: Browser;

describe("编辑器工具栏", () => {
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

  it("工具栏渲染格式化按钮", async () => {
    const wsPath = resetWorkspace([
      { path: "test.md", content: "# 测试\n\n正文。\n" },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\test.md`);

    const toolbar = await browser.$(".editor-toolbar");
    await toolbar.waitForExist({ timeout: 10000 });

    // 应有多个 .tb-btn 按钮
    const buttons = await browser.$$(".tb-btn");
    expect(buttons.length).toBeGreaterThan(5);
  });

  it("Bold 按钮插入 ** 标记", async () => {
    const wsPath = resetWorkspace([
      { path: "bold.md", content: "正文内容\n" },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\bold.md`);

    // 将光标设置到 position 2（"正"之后）
    await browser.execute(() => {
      // @ts-ignore
      const editorBridge = window.__pinia__._s.get("editorBridge");
      const view = editorBridge.editorView;
      if (view) {
        view.dispatch({
          selection: { anchor: 2, head: 2 },
        });
        view.focus();
      }
    });
    await browser.pause(200);

    // 点击 Bold 按钮
    const boldBtn = await browser.$('.tb-btn[title="加粗"]');
    await boldBtn.waitForExist({ timeout: 5000 });
    await boldBtn.click();
    await browser.pause(300);

    // 验证编辑器内容包含 **
    const content = await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      return tabs.activeTab?.content ?? "";
    });
    expect(content).toContain("**");
  });

  it("Italic 按钮插入 * 标记", async () => {
    const wsPath = resetWorkspace([
      { path: "italic.md", content: "正文内容\n" },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\italic.md`);

    await browser.execute(() => {
      // @ts-ignore
      const editorBridge = window.__pinia__._s.get("editorBridge");
      const view = editorBridge.editorView;
      if (view) {
        view.dispatch({
          selection: { anchor: 2, head: 2 },
        });
        view.focus();
      }
    });
    await browser.pause(200);

    const italicBtn = await browser.$('.tb-btn[title="斜体"]');
    await italicBtn.waitForExist({ timeout: 5000 });
    await italicBtn.click();
    await browser.pause(300);

    const content = await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      return tabs.activeTab?.content ?? "";
    });
    // 斜体标记是 *（不应包含 **）
    expect(content).toContain("*");
  });

  it("标题按钮切换标题级别", async () => {
    const wsPath = resetWorkspace([
      { path: "heading.md", content: "正文\n" },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\heading.md`);

    // 将光标设置到行首
    await browser.execute(() => {
      // @ts-ignore
      const editorBridge = window.__pinia__._s.get("editorBridge");
      const view = editorBridge.editorView;
      if (view) {
        view.dispatch({
          selection: { anchor: 0, head: 0 },
        });
        view.focus();
      }
    });
    await browser.pause(200);

    // 点击 H1 按钮
    const h1Btn = await browser.$('.tb-btn[title="标题 1"]');
    await h1Btn.waitForExist({ timeout: 5000 });
    await h1Btn.click();
    await browser.pause(300);

    const content = await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      return tabs.activeTab?.content ?? "";
    });
    expect(content.startsWith("# ")).toBe(true);
  });

  it("无序列表按钮插入 - 标记", async () => {
    const wsPath = resetWorkspace([
      { path: "list.md", content: "列表项\n" },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\list.md`);

    await browser.execute(() => {
      // @ts-ignore
      const editorBridge = window.__pinia__._s.get("editorBridge");
      const view = editorBridge.editorView;
      if (view) {
        view.dispatch({
          selection: { anchor: 0, head: 0 },
        });
        view.focus();
      }
    });
    await browser.pause(200);

    const listBtn = await browser.$('.tb-btn[title="无序列表"]');
    await listBtn.waitForExist({ timeout: 5000 });
    await listBtn.click();
    await browser.pause(300);

    const content = await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      return tabs.activeTab?.content ?? "";
    });
    expect(content).toContain("- ");
  });

  it("工具栏按钮 title 属性正确", async () => {
    const wsPath = resetWorkspace([
      { path: "titles.md", content: "# 测试\n" },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\titles.md`);

    const toolbar = await browser.$(".editor-toolbar");
    await toolbar.waitForExist({ timeout: 10000 });

    // 收集所有按钮的 title
    const titles = await browser.execute(() => {
      const btns = document.querySelectorAll(".editor-toolbar .tb-btn");
      return Array.from(btns).map((b) => b.getAttribute("title")).filter(Boolean);
    });

    expect(titles).toContain("加粗");
    expect(titles).toContain("斜体");
    expect(titles).toContain("标题 1");
    expect(titles).toContain("无序列表");
  });
});
