/**
 * 编辑器 + 预览 同步测试
 * 验证：
 * - CodeMirror 编辑器加载
 * - 修改源码后预览同步渲染
 * - 主题切换反映到预览区
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace, defaultFixtureFiles } from "../helpers/fixtures";
import {
  openWorkspace,
  closeWorkspace,
  openFileInTab,
  setActiveContent
} from "../helpers/store";

let browser: Browser;

describe("编辑器 + 预览 同步", () => {
  beforeAll(async () => {
    browser = await createSession();
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  beforeEach(async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    try {
      await closeWorkspace(browser);
    } catch {
      // ignore
    }
    await openWorkspace(browser, wsPath);
    await (await browser.$(".file-tree")).waitForExist({ timeout: 10000 });
  });

  it("打开 .md 文件后 CodeMirror 编辑器可见", async () => {
    const ws = resetWorkspace(defaultFixtureFiles());
    await openFileInTab(browser, `${ws}/intro.md`);

    const cm = await browser.$(".pane-left .cm-editor");
    await cm.waitForExist({ timeout: 10000 });
    expect(await cm.isDisplayed()).toBe(true);
  });

  it("预览面板可见且包含 markdown-body", async () => {
    const ws = resetWorkspace(defaultFixtureFiles());
    await openFileInTab(browser, `${ws}/intro.md`);

    const preview = await browser.$(".pane-right .markdown-body");
    await preview.waitForExist({ timeout: 10000 });
    expect(await preview.isDisplayed()).toBe(true);
  });

  it("预览渲染一级标题", async () => {
    const ws = resetWorkspace(defaultFixtureFiles());
    await openFileInTab(browser, `${ws}/intro.md`);

    // intro.md 第一行是 "# 简介"
    const h1 = await browser.$(".pane-right .markdown-body h1");
    await h1.waitForExist({ timeout: 10000 });
    const text = (await h1.getText()).trim();
    expect(text).toBe("简介");
  });

  it("修改源码后预览同步更新", async () => {
    const ws = resetWorkspace(defaultFixtureFiles());
    await openFileInTab(browser, `${ws}/intro.md`);

    // 修改源码（通过 store action，避免直接操作 CodeMirror 输入）
    await setActiveContent(browser, "# 新标题\n\n新段落。\n");

    // 预览应显示新标题
    const h1 = await browser.$(".pane-right .markdown-body h1");
    await browser.waitUntil(async () => {
      const text = (await h1.getText()).trim();
      return text === "新标题";
    }, { timeout: 5000 });
    expect((await h1.getText()).trim()).toBe("新标题");
  });

  it("任务列表勾选项在预览中渲染为 checkbox", async () => {
    const ws = resetWorkspace([
      {
        path: "tasks.md",
        content: "# 任务\n\n- [x] 已完成项\n- [ ] 未完成项\n"
      }
    ]);
    await openFileInTab(browser, `${ws}/tasks.md`);

    const checkbox = await browser.$(".pane-right .markdown-body input[type=checkbox]");
    await checkbox.waitForExist({ timeout: 10000 });
    expect(await checkbox.isDisplayed()).toBe(true);
  });

  it("切换主题后预览根元素类名变化", async () => {
    const ws = resetWorkspace(defaultFixtureFiles());
    await openFileInTab(browser, `${ws}/intro.md`);

    // 默认主题
    const preview = await browser.$(".preview-pane");
    await preview.waitForExist({ timeout: 10000 });
    const initialClass = (await preview.getAttribute("class")).split(/\s+/);

    // 通过 Tauri event API 触发 menu-event（模拟用户点击"主题 -> night"菜单）
    // 走真实代码路径：App.vue listen -> handleMenuEvent -> currentTheme.value = "night"
    await browser.executeAsync((theme, done) => {
      // @ts-ignore
      window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "menu-event",
        payload: `theme-${theme}`
      }).then(
        () => done(null),
        (err) => done(err ? String(err) : null)
      );
    }, "night");

    // 等待 .theme-night 出现
    await browser.waitUntil(
      async () => {
        const cls = (await preview.getAttribute("class")).split(/\s+/);
        return cls.includes("theme-night");
      },
      { timeout: 5000 }
    );

    const newClass = (await preview.getAttribute("class")).split(/\s+/);
    expect(newClass).toContain("theme-night");
    // 之前的主题类应该被替换
    const initialTheme = initialClass.find(c => c.startsWith("theme-") && c !== "theme-night");
    if (initialTheme) {
      expect(newClass).not.toContain(initialTheme);
    }
  });
});
