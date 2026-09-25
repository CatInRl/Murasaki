/**
 * 右键菜单键盘导航 E2E 测试（0.9.0 / #191 键盘可达）
 *
 * 验证：
 * - 打开时焦点进入菜单（role=menu + tabindex=-1）
 * - ↑/↓ 移动高亮并跳过分隔线与禁用项
 * - Home / End 跳首尾
 * - Enter 触发当前项 action 并关闭
 * - Esc 关闭并把焦点归还给触发元素
 *
 * 通过 contextMenu store 直接 show 菜单（绕过原生 contextmenu 事件）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { waitForPinia, dismissAllDialogs } from "../helpers/store";

let browser: Browser;

/** 在菜单上派发 keydown（菜单的 keydown 监听挂在 window 捕获阶段） */
async function pressMenuKey(b: Browser, key: string): Promise<void> {
  await b.execute((k: string) => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })
    );
  }, key);
  await b.pause(200);
}

/** 当前高亮项的下标（无则 -1） */
async function activeIndex(b: Browser): Promise<number> {
  return b.execute(() => {
    const items = Array.from(
      document.querySelectorAll(".murasaki-context-menu-item")
    );
    return items.findIndex((el) => el.classList.contains("is-active"));
  });
}

/** 展示一个含分隔线 + 禁用项的菜单，并把某个按钮设为「触发元素」 */
async function showTestMenu(b: Browser): Promise<void> {
  await b.execute(() => {
    // @ts-ignore
    window.__menuAction = null;
    const trigger = document.querySelector(
      ".status-mode-chip"
    ) as HTMLElement | null;
    trigger?.focus();

    const menu = window.__pinia__._s.get("contextMenu");
    menu.show(new MouseEvent("contextmenu", { clientX: 120, clientY: 120 }), [
      {
        label: "第一项",
        // @ts-ignore
        action: () => ((window as any).__menuAction = "first"),
      },
      { separator: true },
      { label: "禁用项", disabled: true },
      {
        label: "第三项",
        // @ts-ignore
        action: () => ((window as any).__menuAction = "third"),
      },
    ]);
  });
  const menu = await browser.$(".murasaki-context-menu");
  await menu.waitForExist({ timeout: 5000 });
  await browser.pause(200);
}

describe("右键菜单键盘导航", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  beforeEach(async () => {
    await dismissAllDialogs(browser);
    await browser.execute(() => {
      // @ts-ignore
      window.__pinia__._s.get("contextMenu").hide();
    });
    await browser.pause(150);
  });

  it("打开菜单后焦点进入菜单容器", async () => {
    await showTestMenu(browser);
    const focusedIsMenu = await browser.execute(
      () =>
        (document.activeElement as HTMLElement | null)?.classList.contains(
          "murasaki-context-menu"
        ) ?? false
    );
    expect(focusedIsMenu).toBe(true);
  });

  it("↓ 跳过禁用项与分隔线，Home/End 跳首尾", async () => {
    await showTestMenu(browser);
    // 初始高亮第一项
    expect(await activeIndex(browser)).toBe(0);

    // ↓ 跳过 idx=1 分隔线、idx=2 禁用项 → idx=3
    await pressMenuKey(browser, "ArrowDown");
    expect(await activeIndex(browser)).toBe(3);

    await pressMenuKey(browser, "Home");
    expect(await activeIndex(browser)).toBe(0);

    await pressMenuKey(browser, "End");
    expect(await activeIndex(browser)).toBe(3);

    // ↑ 回到第一项（同样跳过禁用项）
    await pressMenuKey(browser, "ArrowUp");
    expect(await activeIndex(browser)).toBe(0);

    await browser.execute(() => {
      // @ts-ignore
      window.__pinia__._s.get("contextMenu").hide();
    });
  });

  it("Enter 触发当前项 action 并关闭菜单", async () => {
    await showTestMenu(browser);
    await pressMenuKey(browser, "ArrowDown"); // → 第三项
    await pressMenuKey(browser, "Enter");

    const menuEl = await browser.$(".murasaki-context-menu");
    await menuEl.waitForExist({ timeout: 5000, reverse: true });

    const action = await browser.execute(() => {
      // @ts-ignore
      return (window as any).__menuAction;
    });
    expect(action).toBe("third");
  });

  it("Esc 关闭菜单并把焦点归还触发元素", async () => {
    await showTestMenu(browser);
    await pressMenuKey(browser, "Escape");

    const menuEl = await browser.$(".murasaki-context-menu");
    await menuEl.waitForExist({ timeout: 5000, reverse: true });

    const focusedClass = await browser.execute(
      () => (document.activeElement as HTMLElement | null)?.className ?? ""
    );
    expect(focusedClass).toContain("status-mode-chip");
  });
});
