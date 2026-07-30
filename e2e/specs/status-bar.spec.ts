/**
 * 状态栏 E2E 测试（议题簇 1 / T1.3）
 *
 * 验证：
 * - 无文件时显示"未打开文件"
 * - 有文件时显示文件名和路径
 * - 光标位置显示
 * - 字符数显示
 * - 已保存/未保存指示
 * - provider chip 显示
 *
 * 通过 Pinia store 操作 tabs/workspace，验证 StatusBar 渲染。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace, defaultFixtureFiles } from "../helpers/fixtures";
import { openWorkspace, closeWorkspace, openFileInTab, closeAllTabs, waitForPinia, dismissAllDialogs } from "../helpers/store";

let browser: Browser;

describe("状态栏", () => {
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
    await dismissAllDialogs(browser);
  });

  it("无文件时显示「未打开文件」", async () => {
    // 确保有 tab（EditorPane 挂载）但无文件路径
    // 关闭工作区后状态栏应显示"未打开文件"
    await browser.waitUntil(async () => {
      const statusBar = await browser.$(".status-bar");
      return statusBar.isExisting();
    }, { timeout: 10000 });

    const fileName = await browser.$(".status-filename");
    await fileName.waitForExist({ timeout: 10000 });
    // 前序 spec 可能持久化了 tabs，closeAllTabs 后 Vue 异步渲染需要时间更新状态栏
    await browser.waitUntil(async () => {
      const text = (await fileName.getText()).trim();
      return text === "未打开文件";
    }, { timeout: 5000 });
    expect((await fileName.getText()).trim()).toBe("未打开文件");
  });

  it("打开文件后显示文件名", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    const fileName = await browser.$(".status-filename");
    await fileName.waitForExist({ timeout: 10000 });
    const nameText = (await fileName.getText()).trim();
    expect(nameText).toBe("intro.md");
  });

  it("显示光标位置（行 X, 列 Y）", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    // 等待状态栏渲染光标位置
    const cursorGroup = await browser.$(".status-group");
    await cursorGroup.waitForExist({ timeout: 10000 });

    // 获取所有 status-group 文本，找包含"行"的
    const groups = await browser.$$(".status-group");
    let foundCursor = false;
    for (const g of groups) {
      const text = await g.getText();
      if (text.includes("行") && text.includes("列")) {
        foundCursor = true;
        expect(text).toMatch(/行\s*\d+,?\s*列\s*\d+/);
        break;
      }
    }
    expect(foundCursor).toBe(true);
  });

  it("显示字符数", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    // 等待字符数显示
    await browser.waitUntil(async () => {
      const groups = await browser.$$(".status-group");
      for (const g of groups) {
        const text = await g.getText();
        if (text.includes("字符")) return true;
      }
      return false;
    }, { timeout: 10000 });

    const groups = await browser.$$(".status-group");
    let foundCharCount = false;
    for (const g of groups) {
      const text = await g.getText();
      if (text.includes("字符")) {
        foundCharCount = true;
        expect(text).toMatch(/\d+\s*字符/);
        break;
      }
    }
    expect(foundCharCount).toBe(true);
  });

  it("新文件（未保存）显示「未保存」指示", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    // 修改内容使其变 dirty
    await browser.execute(() => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const tabs = pinia._s.get("tabs");
      if (tabs.activeTab) {
        tabs.updateContent(tabs.activeTab.id, (tabs.activeTab.content ?? "") + "\n# 修改");
      }
    });

    // 等待未保存指示出现
    const unsaved = await browser.$(".status-unsaved");
    await unsaved.waitForExist({ timeout: 5000 });
    expect(await unsaved.isDisplayed()).toBe(true);
    expect((await unsaved.getText()).trim()).toBe("未保存");
  });

  it("已保存文件显示「已保存」指示", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    // 文件刚打开，isDirty 应为 false → 显示"已保存"
    const saved = await browser.$(".status-saved");
    await saved.waitForExist({ timeout: 10000 });
    expect(await saved.isDisplayed()).toBe(true);
    expect((await saved.getText()).trim()).toBe("已保存");
  });

  it("配置 provider 后显示 provider chip", async () => {
    // 通过 store 直接添加 provider
    await browser.execute(() => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const aiProviders = pinia._s.get("aiProviders");
      // 直接设置 providers 数组（绕过 saveProvider 的 Tauri 命令）
      aiProviders.providers = [{
        id: "test-provider",
        name: "TestProvider",
        type: "custom",
        baseUrl: "https://example.com",
        model: "test-model",
        isActive: true,
      }];
    });

    const chip = await browser.$(".status-provider-chip");
    await chip.waitForExist({ timeout: 5000 });
    expect(await chip.isDisplayed()).toBe(true);
    expect((await chip.getText()).trim()).toBe("TestProvider");

    // 清理
    await browser.execute(() => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const aiProviders = pinia._s.get("aiProviders");
      aiProviders.providers = [];
    });
  });
});
