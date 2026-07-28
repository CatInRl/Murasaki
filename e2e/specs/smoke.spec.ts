/**
 * Murasaki 启动 smoke 测试
 * 验证：
 * - 应用窗口能启动并显示标题
 * - 欢迎页可见，包含核心入口按钮
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { closeWorkspace, closeAllTabs } from "../helpers/store";

let browser: Browser;

describe("Murasaki 启动 smoke 测试", () => {
  beforeAll(async () => {
    browser = await createSession();
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  beforeEach(async () => {
    // 全量 E2E 跑时，前序 spec 持久化了 lastWorkspacePath/tabs，
    // 新 session 启动时会恢复，导致 smoke 不是欢迎页。
    // 这里清理 workspace + tabs，确保回到欢迎页。
    try {
      await closeAllTabs(browser);
      await closeWorkspace(browser);
    } catch {
      // ignore
    }
  });

  it("窗口标题为 Murasaki", async () => {
    const title = await browser.getTitle();
    expect(title).toBe("Murasaki");
  });

  it("显示欢迎页（.welcome-page 存在且可见）", async () => {
    const el = await browser.$(".welcome-page");
    await el.waitForExist({ timeout: 15000 });
    expect(await el.isDisplayed()).toBe(true);
  });

  it("欢迎页包含 'Murasaki' 标题文本", async () => {
    const titleEl = await browser.$(".welcome-page .brand-title");
    await titleEl.waitForExist({ timeout: 10000 });
    const text = (await titleEl.getText()).trim();
    expect(text).toBe("Murasaki");
  });

  it("欢迎页提供'打开文件夹'入口", async () => {
    // WelcomePage 用 .action-card > .action-label 结构渲染按钮
    // button=TEXT 选择器只匹配直接文本节点，不匹配嵌套 span，所以用 .action-label
    const label = await browser.$(".action-label=打开文件夹");
    await label.waitForExist({ timeout: 10000 });
    expect(await label.isDisplayed()).toBe(true);
  });

  it("欢迎页提供'打开文件'和'新建文件'入口", async () => {
    const openFile = await browser.$(".action-label=打开文件");
    const newFile = await browser.$(".action-label=新建文件");
    await openFile.waitForExist({ timeout: 10000 });
    await newFile.waitForExist({ timeout: 10000 });
    expect(await openFile.isDisplayed()).toBe(true);
    expect(await newFile.isDisplayed()).toBe(true);
  });
});
