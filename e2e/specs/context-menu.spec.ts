/**
 * 右键菜单 E2E 测试（议题簇 2 / Ticket #67）
 *
 * 验证：
 * - 右键菜单渲染菜单项
 * - 点击菜单项触发 action 并关闭
 * - 禁用项不触发 action
 * - 分隔符渲染
 * - Escape 关闭菜单
 * - 点击外部关闭菜单
 *
 * 通过 Pinia store 直接 show 菜单（绕过 contextmenu 事件）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { waitForPinia, dismissAllDialogs } from "../helpers/store";

let browser: Browser;

describe("右键菜单", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  beforeEach(async () => {
    // 右键菜单不依赖工作区状态，只需隐藏残留菜单
    // 不调用 closeWorkspace：全量 E2E 中 closeWorkspace 可能触发重渲染，
    // 干扰 ContextMenuContainer 的 Teleport 渲染时机
    await browser.execute(() => {
      // @ts-ignore
      const menu = window.__pinia__._s.get("contextMenu");
      if (menu) menu.hide();
    });
    // 关闭前序 spec 残留的 dialog / toast（dialog-overlay 会遮挡菜单）
    await dismissAllDialogs(browser);
    // 等待 hide 生效（v-if 移除 DOM）
    await browser.pause(150);
  });

  it("渲染菜单项", async () => {
    // 使用 show() 触发菜单（与其他测试一致，全量 E2E 下比直接赋值更稳定）
    await browser.execute(() => {
      // @ts-ignore
      const menu = window.__pinia__._s.get("contextMenu");
      menu.show(
        new MouseEvent("contextmenu", { clientX: 100, clientY: 100 }),
        [
          { label: "重命名" },
          { label: "删除", danger: true },
        ]
      );
    });

    const menuEl = await browser.$(".murasaki-context-menu");
    await menuEl.waitForDisplayed({ timeout: 5000 });

    const items = await browser.$$(".murasaki-context-menu-item");
    expect(items.length).toBe(2);

    // webdriverio 9.x $$ 数组索引访问需用 await
    const label0 = await items[0].$(".murasaki-context-menu-label");
    const label1 = await items[1].$(".murasaki-context-menu-label");
    expect((await label0.getText()).trim()).toBe("重命名");
    expect((await label1.getText()).trim()).toBe("删除");

    // danger 项应有 is-danger class
    expect(await items[1].getAttribute("class")).toContain("is-danger");
  });

  it("点击菜单项触发 action 并关闭", async () => {
    await browser.execute(() => {
      // @ts-ignore
      const menu = window.__pinia__._s.get("contextMenu");
      // @ts-ignore
      window.__actionCalled = false;
      menu.show(
        new MouseEvent("contextmenu", { clientX: 100, clientY: 100 }),
        [
          {
            label: "点击我",
            action: () => {
              // @ts-ignore
              window.__actionCalled = true;
            },
          },
        ]
      );
    });

    const item = await browser.$(".murasaki-context-menu-item");
    await item.waitForDisplayed({ timeout: 5000 });
    await item.click();

    // 菜单应关闭
    const menuEl = await browser.$(".murasaki-context-menu");
    await menuEl.waitForExist({ timeout: 5000, reverse: true });

    const called = await browser.execute(() => {
      // @ts-ignore
      return window.__actionCalled;
    });
    expect(called).toBe(true);
  });

  it("禁用项不触发 action", async () => {
    await browser.execute(() => {
      // @ts-ignore
      const menu = window.__pinia__._s.get("contextMenu");
      // @ts-ignore
      window.__disabledActionCalled = false;
      menu.show(
        new MouseEvent("contextmenu", { clientX: 100, clientY: 100 }),
        [
          {
            label: "禁用项",
            disabled: true,
            action: () => {
              // @ts-ignore
              window.__disabledActionCalled = true;
            },
          },
        ]
      );
    });

    const item = await browser.$(".murasaki-context-menu-item");
    await item.waitForExist({ timeout: 5000 });
    expect(await item.getAttribute("class")).toContain("is-disabled");

    // 点击禁用项（不应触发 action，也不应关闭菜单）
    await item.click();

    const called = await browser.execute(() => {
      // @ts-ignore
      return window.__disabledActionCalled;
    });
    expect(called).toBe(false);

    // 菜单仍应可见
    const menuEl = await browser.$(".murasaki-context-menu");
    expect(await menuEl.isExisting()).toBe(true);
  });

  it("分隔符渲染", async () => {
    await browser.execute(() => {
      // @ts-ignore
      const menu = window.__pinia__._s.get("contextMenu");
      menu.show(
        new MouseEvent("contextmenu", { clientX: 100, clientY: 100 }),
        [
          { label: "剪切" },
          { separator: true },
          { label: "删除" },
        ]
      );
    });

    const menuEl = await browser.$(".murasaki-context-menu");
    await menuEl.waitForExist({ timeout: 5000 });

    const separators = await browser.$$(".murasaki-context-menu-separator");
    expect(separators.length).toBe(1);

    const items = await browser.$$(".murasaki-context-menu-item");
    expect(items.length).toBe(2);
  });

  it("Escape 关闭菜单", async () => {
    await browser.execute(() => {
      // @ts-ignore
      const menu = window.__pinia__._s.get("contextMenu");
      menu.show(
        new MouseEvent("contextmenu", { clientX: 100, clientY: 100 }),
        [{ label: "测试" }]
      );
    });

    const menuEl = await browser.$(".murasaki-context-menu");
    await menuEl.waitForExist({ timeout: 5000 });

    await browser.keys(["Escape"]);

    await menuEl.waitForExist({ timeout: 5000, reverse: true });
  });

  it("点击外部关闭菜单", async () => {
    await browser.execute(() => {
      // @ts-ignore
      const menu = window.__pinia__._s.get("contextMenu");
      menu.show(
        new MouseEvent("contextmenu", { clientX: 100, clientY: 100 }),
        [{ label: "测试" }]
      );
    });

    const menuEl = await browser.$(".murasaki-context-menu");
    await menuEl.waitForExist({ timeout: 5000 });

    // 点击 body（菜单外部）
    await browser.$("body").click();

    await menuEl.waitForExist({ timeout: 5000, reverse: true });
  });

  it("shortcut 提示渲染", async () => {
    await browser.execute(() => {
      // @ts-ignore
      const menu = window.__pinia__._s.get("contextMenu");
      menu.show(
        new MouseEvent("contextmenu", { clientX: 100, clientY: 100 }),
        [
          { label: "重命名", shortcut: "F2" },
        ]
      );
    });

    const shortcut = await browser.$(".murasaki-context-menu-shortcut");
    await shortcut.waitForExist({ timeout: 5000 });
    expect((await shortcut.getText()).trim()).toBe("F2");
  });
});
