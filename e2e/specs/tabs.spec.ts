/**
 * 多 Tab 管理 测试
 * 验证：
 * - 新建 Tab 按钮（+）
 * - 多 Tab 显示与切换
 * - 关闭 Tab
 * - 未保存修改的 dirty 标记
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace, defaultFixtureFiles } from "../helpers/fixtures";
import {
  openWorkspace,
  closeWorkspace,
  openFileInTab,
  getTabsState,
  waitForPinia,
  resetPersistenceSettings
} from "../helpers/store";

let browser: Browser;

describe("多 Tab 管理", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  beforeEach(async () => {
    await resetPersistenceSettings(browser);
    const wsPath = resetWorkspace(defaultFixtureFiles());
    try {
      await closeWorkspace(browser);
    } catch {
      // ignore
    }
    await openWorkspace(browser, wsPath);
    // 等待侧栏就绪
    await (await browser.$(".file-tree")).waitForExist({ timeout: 10000 });
  });

  it("点击 + 按钮新建未命名 Tab", async () => {
    // TabBar 仅在 hasTabs 时渲染，先打开一个文件让 TabBar 出现
    const ws = resetWorkspace(defaultFixtureFiles());
    await openFileInTab(browser, `${ws}/intro.md`);
    await (await browser.$(".new-tab-btn")).waitForExist({ timeout: 5000 });

    const initial = await getTabsState(browser);
    const initialCount = initial.tabs.length;

    const newBtn = await browser.$(".new-tab-btn");
    await newBtn.click();

    // 等待 tab 出现
    await browser.waitUntil(
      async () => (await getTabsState(browser)).tabs.length === initialCount + 1,
      { timeout: 5000 }
    );

    const after = await getTabsState(browser);
    expect(after.tabs.length).toBe(initialCount + 1);
    // 新 tab 应为未命名且无 path
    const newTab = after.tabs[after.tabs.length - 1];
    expect(newTab.path).toBeNull();
    expect(newTab.title).toBe("未命名");
  });

  it("通过 store 打开两个文件，应有两个 Tab", async () => {
    const wsPath = (await getTabsState(browser)).tabs; // no-op，仅复用 wsPath
    void wsPath;
    const ws = resetWorkspace(defaultFixtureFiles());

    await openFileInTab(browser, `${ws}/intro.md`);
    await openFileInTab(browser, `${ws}/notes.md`);

    await browser.waitUntil(
      async () => (await getTabsState(browser)).tabs.length >= 2,
      { timeout: 5000 }
    );

    const state = await getTabsState(browser);
    const titles = state.tabs.map(t => t.title);
    expect(titles).toEqual(expect.arrayContaining(["intro.md", "notes.md"]));
  });

  it("点击 Tab 切换激活态", async () => {
    const ws = resetWorkspace(defaultFixtureFiles());
    await openFileInTab(browser, `${ws}/intro.md`);
    await openFileInTab(browser, `${ws}/notes.md`);

    // 等待两个 tab 都出现
    await browser.waitUntil(
      async () => (await getTabsState(browser)).tabs.length >= 2,
      { timeout: 5000 }
    );

    // 点击 intro.md tab
    const introTab = await browser.$(".tab-title=intro.md");
    await introTab.click();

    // activeTabId 应对应 intro.md 的 tab
    const state = await getTabsState(browser);
    const activeTab = state.tabs.find(t => t.id === state.activeTabId);
    expect(activeTab?.title).toBe("intro.md");

    // 视觉上：.active class 应该在 intro.md tab 上
    const activeTabEl = await browser.$(".tab-item.active .tab-title");
    expect((await activeTabEl.getText()).trim()).toBe("intro.md");
  });

  it("点击 Tab 关闭按钮关闭 Tab", async () => {
    const ws = resetWorkspace(defaultFixtureFiles());
    await openFileInTab(browser, `${ws}/intro.md`);
    await openFileInTab(browser, `${ws}/notes.md`);

    await browser.waitUntil(
      async () => (await getTabsState(browser)).tabs.length >= 2,
      { timeout: 5000 }
    );
    const before = (await getTabsState(browser)).tabs.length;

    // 关闭 intro.md tab（第一个 .close-btn）
    const closeBtn = await browser.$(".tab-bar-container .tab-item .close-btn");
    await closeBtn.click();

    await browser.waitUntil(
      async () => (await getTabsState(browser)).tabs.length === before - 1,
      { timeout: 5000 }
    );
  });

  it("修改内容后 Tab 显示 dirty 标记", async () => {
    const ws = resetWorkspace(defaultFixtureFiles());
    await openFileInTab(browser, `${ws}/intro.md`);

    // 通过 store 修改内容
    await browser.execute((content: string) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const tabs = pinia._s.get("tabs");
      if (tabs.activeTab) tabs.updateContent(tabs.activeTab.id, content);
    }, "# 修改后的内容\n");

    // 等待 dirty-dot 出现（TabBar.vue 用 .dirty-dot 不是 .dirty-mark）
    const dirtyMark = await browser.$(".tab-bar-container .tab-item.active .dirty-dot");
    await dirtyMark.waitForExist({ timeout: 3000 });
    expect(await dirtyMark.isDisplayed()).toBe(true);

    // store 中 isDirty 应为 true
    const state = await getTabsState(browser);
    const activeTab = state.tabs.find(t => t.id === state.activeTabId);
    expect(activeTab?.isDirty).toBe(true);
  });

  it("撤销到原始内容后 dirty 标记清除", async () => {
    const wsPath = resetWorkspace([
      { path: "undo-test.md", content: "# 标题\n\n正文\n" },
    ]);
    await openFileInTab(browser, `${wsPath}\\undo-test.md`);

    // 等待编辑器加载（CodeMirror 6 的 .cm-content）
    const cmContent = await browser.$(".cm-content");
    await cmContent.waitForExist({ timeout: 5000 });

    // 通过 CodeMirror view 在光标处插入文本（模拟真实输入）
    await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      const view = window.__editorRef__?.getView?.();
      if (!view) return done("no editor view");
      try {
        view.focus();
        view.dispatch(view.state.replaceSelection("X"));
        done(null);
      } catch (e) {
        done(String(e));
      }
    });

    // 等待 store 同步（CodeMirror updateListener 异步触发 updateContent）
    await browser.waitUntil(async () => {
      const isDirty = await browser.execute(() => {
        // @ts-ignore
        const tabs = window.__pinia__._s.get("tabs");
        return tabs.activeTab?.isDirty;
      });
      return isDirty === true;
    }, { timeout: 3000, timeoutMsg: "输入后 dirty 标记未出现" });

    // 验证 dirty 标记存在
    let isDirty = await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      return tabs.activeTab?.isDirty;
    });
    expect(isDirty).toBe(true);

    // 触发 CodeMirror undo（通过 App.vue 暴露的 window.__editorRef__.undo）
    await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      if (!window.__editorRef__?.undo) return done("no undo");
      // @ts-ignore
      try { window.__editorRef__.undo(); done(null); }
      catch (e) { done(String(e)); }
    });

    // 等待 store 同步（undo 触发 updateListener → updateContent → 与 savedContent 对比）
    await browser.waitUntil(async () => {
      const isDirty = await browser.execute(() => {
        // @ts-ignore
        const tabs = window.__pinia__._s.get("tabs");
        return tabs.activeTab?.isDirty;
      });
      return isDirty === false;
    }, { timeout: 3000, timeoutMsg: "撤销后 dirty 标记未清除" });

    // 验证 dirty 标记消失
    isDirty = await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      return tabs.activeTab?.isDirty;
    });
    expect(isDirty).toBe(false);
  });
});
