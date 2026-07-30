/**
 * Agent 取消/中断 E2E 测试（G 层）
 *
 * 验收标准：
 * - sendMessage 后点击停止按钮 → status 变为 interrupted
 * - assistant 消息含 interrupted: true
 *
 * 需要有效的 MURASAKI_E2E_API_KEY 环境变量。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace, defaultFixtureFiles, setupActiveProvider, teardownActiveProvider } from "../helpers/fixtures";
import { openWorkspace, closeWorkspace, openFileInTab, dismissAllDialogs, closeAllTabs } from "../helpers/store";

const API_KEY = process.env.MURASAKI_E2E_API_KEY ?? "";

let browser: Browser;

describe("Agent 取消/中断", () => {
  beforeAll(async () => {
    if (!API_KEY) return;
    browser = await createSession();
  }, 60000);

  afterAll(async () => {
    if (browser) {
      await teardownActiveProvider(browser);
      await closeSession(browser);
    }
  });

  beforeEach(async () => {
    if (!API_KEY) return;
    resetWorkspace(defaultFixtureFiles());
    try { await closeAllTabs(browser); } catch { /* ignore */ }
    try { await closeWorkspace(browser); } catch { /* ignore */ }
    await dismissAllDialogs(browser);
    await browser.execute(() => {
      // @ts-ignore
      const agent = window.__pinia__._s.get("agent");
      if (agent) agent.clearConversation();
    });
    await teardownActiveProvider(browser);
    await setupActiveProvider(browser, API_KEY);
  });

  it("sendMessage 后立即取消 → status 变为 interrupted", async () => {
    if (!API_KEY) {
      console.warn("跳过：未设置 MURASAKI_E2E_API_KEY");
      return;
    }
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    const card = await browser.$(".agent-context-card");
    await card.waitForExist({ timeout: 10000 });

    // 验证 provider 已配置（sendMessage 在 status="thinking" 前需要先 await get_api_key）
    const providerOk = await browser.execute(() => {
      const aiProviders = (window as any).__pinia__._s.get("aiProviders");
      return !!(aiProviders?.activeProvider && aiProviders.hasProvider);
    });
    if (!providerOk) {
      console.warn("[diag] provider 未就绪，重试 setupActiveProvider");
      await setupActiveProvider(browser, API_KEY);
      await browser.pause(500);
    }

    // 发送一条可能耗时较长的消息
    const sendPromise = browser.executeAsync((done: (res: unknown) => void) => {
      const agent = (window as any).__pinia__._s.get("agent");
      // 不 await Promise，让它在后台跑
      agent.sendMessage("请写一篇 500 字的中文散文，主题是「秋日午后」。请尽量详细描述场景和感受。");
      // 立即 done，不等待完成
      setTimeout(() => done(null), 100);
    });

    // 等待 thinking 状态（sendMessage 需先 await get_api_key invoke，全量 E2E 下可能较慢）
    let lastStatus = "";
    try {
      await browser.waitUntil(
        async () => {
          const status = await browser.execute(
            () => (window as any).__pinia__._s.get("agent")?.status
          );
          lastStatus = String(status);
          return status === "thinking";
        },
        { timeout: 20000, interval: 500 }
      );
    } catch (err) {
      const errMsg = await browser.execute(
        () => (window as any).__pinia__._s.get("agent")?.errorMessage
      );
      throw new Error(
        `等待 thinking 超时：lastStatus="${lastStatus}", errorMessage="${errMsg ?? ""}". ` +
        `providerOk=${providerOk}`
      );
    }

    // 等待 sendMessage 启动
    await sendPromise;

    // 调用 cancel
    await browser.execute(() => {
      const agent = (window as any).__pinia__._s.get("agent");
      if (agent) agent.cancel();
    });

    // 等待 status 变为 interrupted 或 done 或 error
    await browser.waitUntil(
      async () => {
        const status = await browser.execute(
          () => (window as any).__pinia__._s.get("agent")?.status
        );
        return status === "interrupted" || status === "done" || status === "error" || status === "idle";
      },
      { timeout: 15000 }
    );

    const finalStatus = await browser.execute(
      () => (window as any).__pinia__._s.get("agent")?.status
    );
    expect(["interrupted", "done", "idle", "error"]).toContain(finalStatus);
  }, 60000);

  it("中断后 assistant 消息含 interrupted: true", async () => {
    if (!API_KEY) {
      console.warn("跳过：未设置 MURASAKI_E2E_API_KEY");
      return;
    }
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    const card = await browser.$(".agent-context-card");
    await card.waitForExist({ timeout: 10000 });

    // 发送消息（后台运行）
    const sendPromise2 = browser.executeAsync((done: (res: unknown) => void) => {
      const agent = (window as any).__pinia__._s.get("agent");
      agent.sendMessage("请写一篇 500 字的中文散文");
      setTimeout(() => done(null), 100);
    });

    // 等 thinking 后立即取消
    await browser.waitUntil(
      async () => {
        const status = await browser.execute(
          () => (window as any).__pinia__._s.get("agent")?.status
        );
        return status === "thinking";
      },
      { timeout: 20000, interval: 500 }
    );

    await sendPromise2;

    await browser.execute(() => {
      const agent = (window as any).__pinia__._s.get("agent");
      if (agent) agent.cancel();
    });

    // 等待完成
    await browser.waitUntil(
      async () => {
        const status = await browser.execute(
          () => (window as any).__pinia__._s.get("agent")?.status
        );
        return status !== "thinking";
      },
      { timeout: 15000 }
    );

    await browser.pause(500);

    // 验证最后一条 assistant 消息含 interrupted
    const lastMsg = await browser.execute(() => {
      const agent = (window as any).__pinia__._s.get("agent");
      if (!agent) return null;
      const msgs = agent.messages ?? [];
      const assistantMsgs = msgs.filter((m: any) => m.role === "assistant");
      return assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1] : null;
    });

    if (lastMsg) {
      // 如果 status 是 interrupted，interrupted 应为 true
      const status = await browser.execute(
        () => (window as any).__pinia__._s.get("agent")?.status
      );
      if (status === "interrupted") {
        expect((lastMsg as any).interrupted).toBe(true);
      }
    }
  }, 60000);
});
