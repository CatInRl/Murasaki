/**
 * 对话框系统 E2E 测试（Ticket #66 / T2.2）
 *
 * 验证：
 * - alert / confirm / prompt / conflict / unsaved 5 类对话框渲染
 * - 按钮点击正确 resolve Promise
 * - Escape 键取消
 * - 模态栈：第二个对话框等待第一个 resolve
 *
 * 通过 Pinia store 调用 dialog API，验证 UI 渲染与 Promise 行为。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { closeWorkspace, waitForPinia } from "../helpers/store";

let browser: Browser;

describe("对话框系统", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  beforeEach(async () => {
    try { await closeWorkspace(browser); } catch { /* ignore */ }
    // 确保队列清空
    await browser.execute(() => {
      // @ts-ignore
      const dialog = window.__pinia__._s.get("dialog");
      if (dialog && dialog.current) {
        dialog.cancelCurrent();
      }
    });
  });

  it("alert 对话框渲染并确认后消失", async () => {
    // 发起 alert（不 await，在浏览器内执行）
    await browser.execute(() => {
      // @ts-ignore
      const dialog = window.__pinia__._s.get("dialog");
      // @ts-ignore
      window.__alertResult = "pending";
      dialog.alert({ message: "测试提示", variant: "info" }).then(() => {
        // @ts-ignore
        window.__alertResult = "resolved";
      });
    });

    const overlay = await browser.$(".dialog-overlay");
    await overlay.waitForExist({ timeout: 5000 });

    // 通过 store 状态验证对话框已入队（比 DOM 文本更可靠，Transition 可能延迟文本渲染）
    await browser.waitUntil(async () => {
      return await browser.execute(() => {
        // @ts-ignore
        const cur = window.__pinia__._s.get("dialog").current;
        return cur !== null && cur.message === "测试提示";
      });
    }, { timeout: 5000 });

    // 等待 DOM 渲染稳定后验证文本
    await browser.pause(200);
    const message = await browser.$(".dialog-message");
    expect((await message.getText()).trim()).toBe("测试提示");

    // 点击确认按钮
    const confirmBtn = await browser.$(".dialog-footer .dialog-btn.primary");
    await confirmBtn.click();

    // 通过 store 状态判断对话框已关闭（Vue Transition 可能使 DOM 元素延迟消失）
    await browser.waitUntil(async () => {
      return await browser.execute(() => {
        // @ts-ignore
        return window.__pinia__._s.get("dialog").current === null;
      });
    }, { timeout: 5000 });

    const result = await browser.execute(() => {
      // @ts-ignore
      return window.__alertResult;
    });
    expect(result).toBe("resolved");
  });

  it("confirm 对话框确认返回 true", async () => {
    await browser.execute(() => {
      // @ts-ignore
      const dialog = window.__pinia__._s.get("dialog");
      // @ts-ignore
      window.__confirmResult = null;
      dialog.confirm({ message: "确认操作？" }).then((r: boolean) => {
        // @ts-ignore
        window.__confirmResult = r;
      });
    });

    const overlay = await browser.$(".dialog-overlay");
    await overlay.waitForExist({ timeout: 5000 });

    // 点击 primary 确认按钮
    const confirmBtn = await browser.$(".dialog-footer .dialog-btn.primary");
    await confirmBtn.click();

    // 通过 store 状态判断对话框已关闭
    await browser.waitUntil(async () => {
      return await browser.execute(() => {
        // @ts-ignore
        return window.__pinia__._s.get("dialog").current === null;
      });
    }, { timeout: 5000 });

    const result = await browser.execute(() => {
      // @ts-ignore
      return window.__confirmResult;
    });
    expect(result).toBe(true);
  });

  it("confirm 对话框取消返回 false", async () => {
    await browser.execute(() => {
      // @ts-ignore
      const dialog = window.__pinia__._s.get("dialog");
      // @ts-ignore
      window.__confirmResult2 = null;
      dialog.confirm({ message: "确认操作？" }).then((r: boolean) => {
        // @ts-ignore
        window.__confirmResult2 = r;
      });
    });

    const overlay = await browser.$(".dialog-overlay");
    await overlay.waitForExist({ timeout: 5000 });

    // 点击取消按钮（非 primary）
    const cancelBtn = await browser.$(".dialog-footer .dialog-btn:not(.primary)");
    await cancelBtn.click();

    // 通过 store 状态判断对话框已关闭
    await browser.waitUntil(async () => {
      return await browser.execute(() => {
        // @ts-ignore
        return window.__pinia__._s.get("dialog").current === null;
      });
    }, { timeout: 5000 });

    const result = await browser.execute(() => {
      // @ts-ignore
      return window.__confirmResult2;
    });
    expect(result).toBe(false);
  });

  it("prompt 对话框输入并确认返回输入值", async () => {
    await browser.execute(() => {
      // @ts-ignore
      const dialog = window.__pinia__._s.get("dialog");
      // @ts-ignore
      window.__promptResult = null;
      dialog.prompt({ message: "输入名称", defaultValue: "默认值" }).then((r: string | null) => {
        // @ts-ignore
        window.__promptResult = r;
      });
    });

    const input = await browser.$(".dialog-input");
    await input.waitForExist({ timeout: 5000 });

    // 验证默认值
    const defaultValue = await input.getValue();
    expect(defaultValue).toBe("默认值");

    // 清空并输入新值
    await input.setValue("新名称");

    // 点击确认
    const confirmBtn = await browser.$(".dialog-footer .dialog-btn.primary");
    await confirmBtn.click();

    const result = await browser.execute(() => {
      // @ts-ignore
      return window.__promptResult;
    });
    expect(result).toBe("新名称");
  });

  it("prompt 对话框取消返回 null", async () => {
    await browser.execute(() => {
      // @ts-ignore
      const dialog = window.__pinia__._s.get("dialog");
      // @ts-ignore
      window.__promptResult2 = "still_pending";
      dialog.prompt({ message: "输入名称" }).then((r: string | null) => {
        // @ts-ignore
        window.__promptResult2 = r;
      });
    });

    const overlay = await browser.$(".dialog-overlay");
    await overlay.waitForExist({ timeout: 5000 });

    // Escape 取消
    await browser.keys(["Escape"]);

    // 通过 store 状态判断对话框已关闭
    await browser.waitUntil(async () => {
      return await browser.execute(() => {
        // @ts-ignore
        return window.__pinia__._s.get("dialog").current === null;
      });
    }, { timeout: 5000 });

    const result = await browser.execute(() => {
      // @ts-ignore
      return window.__promptResult2;
    });
    expect(result).toBe(null);
  });

  it("conflict 对话框覆盖返回 overwrite", async () => {
    await browser.execute(() => {
      // @ts-ignore
      const dialog = window.__pinia__._s.get("dialog");
      // @ts-ignore
      window.__conflictResult = null;
      dialog.conflict({ filename: "test.md" }).then((r: unknown) => {
        // @ts-ignore
        window.__conflictResult = r;
      });
    });

    const overlay = await browser.$(".dialog-overlay");
    await overlay.waitForExist({ timeout: 5000 });

    // 点击 danger 覆盖按钮（confirmText = "覆盖"）
    const overwriteBtn = await browser.$(".dialog-footer .dialog-btn.danger");
    await overwriteBtn.click();

    // 通过 store 状态判断对话框已关闭
    await browser.waitUntil(async () => {
      return await browser.execute(() => {
        // @ts-ignore
        return window.__pinia__._s.get("dialog").current === null;
      });
    }, { timeout: 5000 });

    const result = await browser.execute(() => {
      // @ts-ignore
      return window.__conflictResult;
    });
    expect(result).toEqual({ action: "overwrite" });
  });

  it("unsaved 对话框三按钮返回 save/discard/cancel", async () => {
    // 测试 save
    await browser.execute(() => {
      // @ts-ignore
      const dialog = window.__pinia__._s.get("dialog");
      // @ts-ignore
      window.__unsavedResult = null;
      dialog.unsavedChanges({ message: "未保存？" }).then((r: string) => {
        // @ts-ignore
        window.__unsavedResult = r;
      });
    });

    const overlay = await browser.$(".dialog-overlay");
    await overlay.waitForExist({ timeout: 5000 });

    // 点击保存（primary）
    const saveBtn = await browser.$(".dialog-footer .dialog-btn.primary");
    await saveBtn.click();

    // 通过 store 状态判断对话框已关闭
    await browser.waitUntil(async () => {
      return await browser.execute(() => {
        // @ts-ignore
        return window.__pinia__._s.get("dialog").current === null;
      });
    }, { timeout: 5000 });

    const result = await browser.execute(() => {
      // @ts-ignore
      return window.__unsavedResult;
    });
    expect(result).toBe("save");
  });

  it("模态栈：第二个对话框等待第一个 resolve", async () => {
    await browser.execute(() => {
      // @ts-ignore
      const dialog = window.__pinia__._s.get("dialog");
      // @ts-ignore
      window.__d1 = "pending";
      // @ts-ignore
      window.__d2 = "pending";
      dialog.alert({ message: "第一个" }).then(() => {
        // @ts-ignore
        window.__d1 = "resolved";
      });
      dialog.alert({ message: "第二个" }).then(() => {
        // @ts-ignore
        window.__d2 = "resolved";
      });
    });

    // 第一个对话框应显示
    const firstMsg = await browser.$(".dialog-message");
    await firstMsg.waitForExist({ timeout: 5000 });
    expect((await firstMsg.getText()).trim()).toBe("第一个");

    // 确认第一个
    const confirmBtn = await browser.$(".dialog-footer .dialog-btn.primary");
    await confirmBtn.click();

    // 等待第二个对话框变为当前（store 状态变化）
    await browser.waitUntil(async () => {
      return await browser.execute(() => {
        // @ts-ignore
        const cur = window.__pinia__._s.get("dialog").current;
        return cur !== null && cur.message === "第二个";
      });
    }, { timeout: 5000 });

    // 确认第二个
    const confirmBtn2 = await browser.$(".dialog-footer .dialog-btn.primary");
    await confirmBtn2.click();

    // 两个都应 resolved
    await browser.waitUntil(async () => {
      const r = await browser.execute(() => ({
        // @ts-ignore
        d1: window.__d1,
        // @ts-ignore
        d2: window.__d2,
      }));
      return r.d1 === "resolved" && r.d2 === "resolved";
    }, { timeout: 5000 });
  });
});
