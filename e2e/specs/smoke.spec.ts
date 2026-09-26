/**
 * Murasaki 启动 smoke 测试
 * 验证：
 * - 应用窗口能启动并显示标题
 * - 欢迎页可见，包含核心入口按钮
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { closeWorkspace, closeAllTabs, waitForPinia } from "../helpers/store";
import { waitForPresent } from "../helpers/wait";

let browser: Browser;

describe("Murasaki 启动 smoke 测试", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  beforeEach(async () => {
    // 全量 E2E 跑时，前序 spec 持久化了 tabs，新 session 启动时 App.vue 的
    // onMounted 会异步 restore()。该恢复可能晚于本处清理落地，把已回到的欢迎页
    // 再替换掉（表现为 .action-label 刚出现就 isDisplayed 为 false）。
    // 因此在轮询里反复清理，直到 tabs 为空且欢迎页确实可见，从根上消除竞态。
    await browser.waitUntil(async () => {
      try {
        await closeAllTabs(browser);
        await closeWorkspace(browser);
      } catch {
        // ignore
      }
      const noTabs = await browser.execute(() => {
        // @ts-ignore
        return window.__pinia__._s.get("tabs").tabs.length === 0;
      });
      if (!noTabs) return false;
      const wp = await browser.$(".welcome-page");
      return await wp.isDisplayed().catch(() => false);
    }, { timeout: 15000 });
  });

  it("窗口标题为 Murasaki", async () => {
    const title = await browser.getTitle();
    expect(title).toBe("Murasaki");
  });

  it("显示欢迎页（.welcome-page 存在且可见）", async () => {
    const el = await browser.$(".welcome-page");
    await waitForPresent(browser, ".welcome-page", 15000);
    expect(await el.isDisplayed()).toBe(true);
  });

  it("欢迎页包含 'Murasaki' 标题文本", async () => {
    const titleEl = await browser.$(".welcome-page .brand-title");
    await waitForPresent(browser, ".welcome-page .brand-title", 10000);
    // Vue 异步渲染可能需要额外时间填充文本
    await browser.waitUntil(async () => {
      const text = (await titleEl.getText()).trim();
      return text.length > 0;
    }, { timeout: 5000 });
    const text = (await titleEl.getText()).trim();
    expect(text).toMatch(/Murasaki/i);
  });

  it("欢迎页提供'打开文件夹'入口", async () => {
    // WelcomePage 用 .action-card > .action-label 结构渲染按钮
    // button=TEXT 选择器只匹配直接文本节点，不匹配嵌套 span，所以用 .action-label
    const label = await browser.$(".action-label=打开文件夹");
    await waitForPresent(browser, ".action-label=打开文件夹", 10000);
    // 元素出现只保证它在 DOM 中，不等同于可见；改为轮询 isDisplayed，
    // 避免读到欢迎页切换过程中的瞬时状态。
    await browser.waitUntil(async () => {
      return await label.isDisplayed().catch(() => false);
    }, { timeout: 5000 });
    expect(await label.isDisplayed()).toBe(true);
  });

  it("欢迎页提供'打开文件'和'新建文件'入口", async () => {
    const openFile = await browser.$(".action-label=打开文件");
    const newFile = await browser.$(".action-label=新建文件");
    await waitForPresent(browser, ".action-label=打开文件", 10000);
    await waitForPresent(browser, ".action-label=新建文件", 10000);
    expect(await openFile.isDisplayed()).toBe(true);
    expect(await newFile.isDisplayed()).toBe(true);
  });
});
