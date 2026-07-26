/**
 * Murasaki 启动 smoke 测试
 * 验证：
 * - 应用窗口能启动并显示标题
 * - 欢迎页可见，包含核心入口按钮
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser } from "webdriverio";
import { createSession } from "../helpers/driver";

let browser: Browser;

describe("Murasaki 启动 smoke 测试", () => {
  beforeAll(async () => {
    browser = await createSession();
  }, 60000);

  afterAll(async () => {
    if (browser) await browser.deleteSession();
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
    const titleEl = await browser.$(".welcome-page .title");
    await titleEl.waitForExist({ timeout: 10000 });
    const text = (await titleEl.getText()).trim();
    expect(text).toBe("Murasaki");
  });

  it("欢迎页提供'打开文件夹'入口", async () => {
    // NButton 渲染为 <button>，通过文本定位
    const btn = await browser.$("button=打开文件夹");
    await btn.waitForExist({ timeout: 10000 });
    expect(await btn.isDisplayed()).toBe(true);
  });

  it("欢迎页提供'打开文件'和'新建文件'入口", async () => {
    const openFile = await browser.$("button=打开文件");
    const newFile = await browser.$("button=新建文件");
    await openFile.waitForExist({ timeout: 10000 });
    await newFile.waitForExist({ timeout: 10000 });
    expect(await openFile.isDisplayed()).toBe(true);
    expect(await newFile.isDisplayed()).toBe(true);
  });
});
