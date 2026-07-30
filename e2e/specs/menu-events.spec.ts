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
  closeAllTabs,
  openFileInTab,
  getTabsState,
  emitMenuEvent,
  waitForPinia,
  ensureSplitMode,
  resetPersistenceSettings
} from "../helpers/store";

let browser: Browser;

describe("菜单事件链", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
    // E2E 全量运行时前序 spec 可能改了 editorMode，强制重置为 split
    await ensureSplitMode(browser);
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  beforeEach(async () => {
    await resetPersistenceSettings(browser);
    const wsPath = resetWorkspace(defaultFixtureFiles());
    try {
      await closeAllTabs(browser);
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

      // 工作区关闭后 workspace.hasWorkspace 应为 false
      // 注意：sidebar 可能有 tab 残留仍显示（App.vue v-if="hasWorkspace || hasTabs"），
      // 所以不检查 .file-tree 是否显示，而是检查 store 状态
      await browser.waitUntil(
        async () => {
          const hasWs = await browser.execute(() => {
            // @ts-ignore
            return window.__pinia__._s.get("workspace").hasWorkspace;
          });
          return hasWs === false;
        },
        { timeout: 5000 }
      );
      expect(true).toBe(true); // waitUntil 通过即成功
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
      const handlesBefore = await browser.getWindowHandles();
      await emitMenuEvent(browser, "settings");
      // 设置窗口现在是独立的 Tauri 多窗口（ADR-0009），不再是 NModal。
      // E2E 环境下第二个 WebView2 无法加载 tauri://localhost/settings.html
      // （additional_browser_args 只注入了主窗口），所以只验证窗口创建。
      // 事件链：emit menu-event → App.vue listener → handleMenuEvent → openSettings → invoke("open_settings")
      // 需要较长超时等待整个异步链完成。
      await browser.waitUntil(
        async () => (await browser.getWindowHandles()).length > handlesBefore.length,
        { timeout: 15000, interval: 500 }
      );
      const handlesAfter = await browser.getWindowHandles();
      expect(handlesAfter.length).toBeGreaterThan(handlesBefore.length);

      // 清理：关闭 settings 窗口（fire-and-forget，invoke Promise 不会 resolve）
      const settingsHandle = handlesAfter.find((h) => !handlesBefore.includes(h));
      if (settingsHandle) {
        await browser.switchToWindow(settingsHandle);
        await browser.executeAsync((done: (res: unknown) => void) => {
          try {
            // @ts-ignore
            window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "settings" });
          } catch { /* ignore */ }
          done(null);
        });
        await browser.pause(500);
        // 切回主窗口
        const mainHandle = handlesBefore[0];
        if (mainHandle) await browser.switchToWindow(mainHandle);
      }
    });
  });
});
