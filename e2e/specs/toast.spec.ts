/**
 * 吐司系统 E2E 测试（议题簇 2 / Ticket #65）
 *
 * 验证：
 * - 6 种变体（success/info/warning/error/progress/deleted）正确渲染
 * - 关闭按钮 dismiss 单条吐司
 * - action 按钮触发回调并关闭
 * - dismissAll 清空所有吐司
 * - 自动消失策略（success 3s）
 *
 * 通过 Pinia store 直接 push 吐司，验证 UI 渲染与交互。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { closeWorkspace, waitForPinia } from "../helpers/store";

let browser: Browser;

describe("吐司系统", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  beforeEach(async () => {
    try { await closeWorkspace(browser); } catch { /* ignore */ }
    // 清空所有吐司
    await browser.execute(() => {
      // @ts-ignore
      const toast = window.__pinia__._s.get("toast");
      if (toast) toast.dismissAll();
    });
    await browser.pause(100);
  });

  it("success 变体渲染标题和图标", async () => {
    await browser.execute(() => {
      // @ts-ignore
      const toast = window.__pinia__._s.get("toast");
      // duration: 0 防止 3s 自动消失导致测试期间 toast 消失
      toast.success("操作成功", { duration: 0 });
    });

    // 使用 waitForExist + pause 替代 waitForDisplayed（后者在 tauri-driver 下
    // 与 transition-group 的 enter-from opacity:0 阶段交互不稳定）
    const item = await browser.$(".toast-item.toast-success");
    await item.waitForExist({ timeout: 5000 });
    // 等待 enter transition 完成（200ms + 余量）
    await browser.pause(400);
    expect(await item.isDisplayed()).toBe(true);

    const title = await browser.$(".toast-success .toast-title");
    expect((await title.getText()).trim()).toBe("操作成功");
  });

  it("error 变体渲染", async () => {
    await browser.execute(() => {
      // @ts-ignore
      const toast = window.__pinia__._s.get("toast");
      toast.error("操作失败");
    });

    const item = await browser.$(".toast-item.toast-error");
    await item.waitForExist({ timeout: 5000 });
    expect(await item.isDisplayed()).toBe(true);
  });

  it("progress 变体显示进度条", async () => {
    await browser.execute(() => {
      // @ts-ignore
      const toast = window.__pinia__._s.get("toast");
      toast.progress("加载中", { progress: 50 });
    });

    const item = await browser.$(".toast-item.toast-progress");
    await item.waitForExist({ timeout: 5000 });

    const bar = await browser.$(".toast-progress .toast-progress-bar");
    await bar.waitForExist({ timeout: 5000 });
    // 进度条 style 应包含 width: 50%
    const style = await bar.getAttribute("style");
    expect(style).toContain("50%");
  });

  it("description 副标题渲染", async () => {
    await browser.execute(() => {
      // @ts-ignore
      const toast = window.__pinia__._s.get("toast");
      toast.info("提示", { description: "详细说明文字" });
    });

    const desc = await browser.$(".toast-info .toast-desc");
    await desc.waitForExist({ timeout: 5000 });
    expect((await desc.getText()).trim()).toBe("详细说明文字");
  });

  it("点击关闭按钮 dismiss 吐司", async () => {
    await browser.execute(() => {
      // @ts-ignore
      const toast = window.__pinia__._s.get("toast");
      // duration: 0 防止自动消失
      toast.warning("警告", { duration: 0 });
    });

    const item = await browser.$(".toast-item.toast-warning");
    await item.waitForExist({ timeout: 5000 });
    expect(await item.isDisplayed()).toBe(true);

    const closeBtn = await browser.$(".toast-warning .toast-close-btn");
    await closeBtn.click();

    // 等待 toast 从 store 中移除（Vue transition 可能使 DOM 元素延迟消失）
    await browser.waitUntil(async () => {
      return await browser.execute(() => {
        // @ts-ignore
        return window.__pinia__._s.get("toast").toasts.length === 0;
      });
    }, { timeout: 5000 });
  });

  it("action 按钮触发回调并关闭吐司", async () => {
    let actionCalled = false;
    await browser.execute(() => {
      // @ts-ignore
      const toast = window.__pinia__._s.get("toast");
      // @ts-ignore
      window.__testActionCalled = false;
      toast.success("已删除", {
        duration: 0,
        action: {
          label: "撤销",
          onClick: () => {
            // @ts-ignore
            window.__testActionCalled = true;
          },
        },
      });
    });

    const actionBtn = await browser.$(".toast-success .toast-action-btn");
    await actionBtn.waitForExist({ timeout: 5000 });
    expect((await actionBtn.getText()).trim()).toBe("撤销");

    await actionBtn.click();

    // 等待 toast 从 store 中移除
    await browser.waitUntil(async () => {
      return await browser.execute(() => {
        // @ts-ignore
        return window.__pinia__._s.get("toast").toasts.length === 0;
      });
    }, { timeout: 5000 });

    // action 应被调用
    const called = await browser.execute(() => {
      // @ts-ignore
      return window.__testActionCalled;
    });
    expect(called).toBe(true);
  });

  it("dismissAll 清空所有吐司", async () => {
    await browser.execute(() => {
      // @ts-ignore
      const toast = window.__pinia__._s.get("toast");
      toast.success("A", { duration: 0 });
      toast.info("B", { duration: 0 });
      toast.error("C", { duration: 0 });
    });

    // 等待 3 条吐司渲染（store 中应有 3 条）
    await browser.waitUntil(async () => {
      return await browser.execute(() => {
        // @ts-ignore
        return window.__pinia__._s.get("toast").toasts.length === 3;
      });
    }, { timeout: 5000 });
    // 等待 DOM 渲染
    await browser.pause(200);

    await browser.execute(() => {
      // @ts-ignore
      const toast = window.__pinia__._s.get("toast");
      toast.dismissAll();
    });

    // 检查 store（source of truth）而非 DOM：transition-group 的 leave 动画
    // 可能在 timeout 窗口内仍保留 DOM 元素
    await browser.waitUntil(async () => {
      return await browser.execute(() => {
        // @ts-ignore
        return window.__pinia__._s.get("toast").toasts.length === 0;
      });
    }, { timeout: 5000 });
  });

  it("success 变体 3 秒后自动消失", async () => {
    await browser.execute(() => {
      // @ts-ignore
      const toast = window.__pinia__._s.get("toast");
      toast.success("自动消失");
    });

    const item = await browser.$(".toast-item.toast-success");
    await item.waitForExist({ timeout: 5000 });
    // 等待 enter transition 完成
    await browser.pause(300);
    expect(await item.isDisplayed()).toBe(true);

    // 等待自动消失（3s 默认 + 余量）
    // 使用手动轮询替代 browser.waitUntil（后者在 tauri-driver 下与
    // browser.execute 组合存在轮询不可靠问题）
    let dismissed = false;
    const start = Date.now();
    while (Date.now() - start < 8000) {
      await browser.pause(500);
      const count = await browser.execute(() => {
        // @ts-ignore
        return window.__pinia__._s.get("toast").toasts.length;
      });
      if (count === 0) {
        dismissed = true;
        break;
      }
    }
    expect(dismissed).toBe(true);
  });
});
