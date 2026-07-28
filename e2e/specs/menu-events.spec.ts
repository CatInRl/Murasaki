/**
 * 菜单事件链 测试
 * 验证 menu.rs 中定义的菜单 ID 通过 Tauri emit menu-event 触发后，
 * App.vue handleMenuEvent 正确响应（覆盖菜单系统集成层）
 *
 * 由于 Tauri 2.x 在 Windows 上使用非 Win32 菜单（GetMenu 返回 0），
 * 无法通过 Win32 API / UIAutomation 点击原生菜单。
 * 本测试通过 Tauri event API emit menu-event 模拟用户点击，
 * 覆盖菜单 → Rust emit → 前端 listen → handleMenuEvent 的完整链路。
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
  emitMenuEvent
} from "../helpers/store";

let browser: Browser;

describe("菜单事件链", () => {
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

  describe("主题切换菜单", () => {
    for (const theme of ["newsprint", "night", "academic", "github"]) {
      it(`menu-event 'theme-${theme}' 切换预览主题`, async () => {
        const ws = resetWorkspace(defaultFixtureFiles());
        await openFileInTab(browser, `${ws}/intro.md`);

        await emitMenuEvent(browser, `theme-${theme}`);

        const preview = await browser.$(".preview-pane");
        await browser.waitUntil(
          async () => {
            const cls = (await preview.getAttribute("class")).split(/\s+/);
            return cls.includes(`theme-${theme}`);
          },
          { timeout: 3000 }
        );
        const cls = (await preview.getAttribute("class")).split(/\s+/);
        expect(cls).toContain(`theme-${theme}`);
      });
    }
  });

  describe("文件菜单", () => {
    it("menu-event 'new-file' 创建未命名 Tab", async () => {
      const ws = resetWorkspace(defaultFixtureFiles());
      await openFileInTab(browser, `${ws}/intro.md`);
      const initial = (await getTabsState(browser)).tabs.length;

      await emitMenuEvent(browser, "new-file");

      await browser.waitUntil(
        async () => (await getTabsState(browser)).tabs.length === initial + 1,
        { timeout: 3000 }
      );
      const after = await getTabsState(browser);
      const newTab = after.tabs[after.tabs.length - 1];
      expect(newTab.path).toBeNull();
      expect(newTab.title).toBe("未命名");
    });

    it("menu-event 'close-tab' 关闭当前 Tab", async () => {
      const ws = resetWorkspace(defaultFixtureFiles());
      await openFileInTab(browser, `${ws}/intro.md`);
      await openFileInTab(browser, `${ws}/notes.md`);
      await browser.waitUntil(
        async () => (await getTabsState(browser)).tabs.length >= 2,
        { timeout: 5000 }
      );
      const before = (await getTabsState(browser)).tabs.length;

      await emitMenuEvent(browser, "close-tab");

      await browser.waitUntil(
        async () => (await getTabsState(browser)).tabs.length === before - 1,
        { timeout: 5000 }
      );
    });

    it("menu-event 'close-workspace' 关闭工作区", async () => {
      // 先打开一个文件让 TabBar 出现，再触发 close-workspace
      const ws = resetWorkspace(defaultFixtureFiles());
      await openFileInTab(browser, `${ws}/intro.md`);

      await emitMenuEvent(browser, "close-workspace");

      // 工作区关闭后文件树应消失
      const fileTree = await browser.$(".file-tree");
      await browser.waitUntil(
        async () => !(await fileTree.isDisplayed()),
        { timeout: 5000 }
      );
      expect(await fileTree.isDisplayed()).toBe(false);
    });
  });

  describe("视图/工具菜单", () => {
    it("menu-event 'find-in-files' 显示搜索面板", async () => {
      // 通过 store 检查 searchStore.visible
      await emitMenuEvent(browser, "find-in-files");
      const visible = await browser.execute(() => {
        // @ts-ignore
        const pinia = window.__pinia__;
        const search = pinia._s.get("search");
        return search?.visible ?? false;
      });
      expect(visible).toBe(true);
    });

    it("menu-event 'settings' 打开设置窗口", async () => {
      await emitMenuEvent(browser, "settings");
      // SettingsWindow 通过 NModal preset="card" 渲染，内部有 .settings-layout
      const layout = await browser.$(".settings-layout");
      await layout.waitForExist({ timeout: 3000 });
      expect(await layout.isDisplayed()).toBe(true);
    });
  });
});
