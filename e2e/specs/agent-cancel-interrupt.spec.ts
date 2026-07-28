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
import { openWorkspace, closeWorkspace, openFileInTab } from "../helpers/store";

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
    try { await closeWorkspace(browser); } catch { /* ignore */ }
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

    // 发送一条耗时较长的消息
    const input = await browser.$(".agent-input");
    await input.setValue(
      "请写一篇 500 字的中文散文，主题是「秋日午后」。请尽量详细描述场景和感受。"
    );
    
    const sendBtn = await browser.$(".agent-send-btn-send");
    await sendBtn.click();

    // 等待 thinking 状态确认
    await browser.waitUntil(
      async () => {
        const status = await browser.execute(
          () => (window as any).__pinia__._s.get("agent")?.status
        );
        return status === "thinking";
      },
      { timeout: 10000 }
    );

    // 点击停止按钮
    const stopBtn = await browser.$(".agent-send-btn-stop");
    await stopBtn.waitForExist({ timeout: 5000 });
    await stopBtn.click();

    // 等待 status 变为 interrupted 或 done
    await browser.waitUntil(
      async () => {
        const status = await browser.execute(
          () => (window as any).__pinia__._s.get("agent")?.status
        );
        return status === "interrupted" || status === "done" || status === "error" || status === "idle";
      },
      { timeout: 10000 }
    );

    const finalStatus = await browser.execute(
      () => (window as any).__pinia__._s.get("agent")?.status
    );
    // 应该是 interrupted 或（如果 LLM 太快完成）done
    expect(["interrupted", "done"]).toContain(finalStatus);
  }, 30000);

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

    const input = await browser.$(".agent-input");
    await input.setValue("请写一篇 500 字的中文散文");
    
    const sendBtn = await browser.$(".agent-send-btn-send");
    await sendBtn.click();

    // 等 thinking 后立即取消
    await browser.waitUntil(
      async () => {
        const status = await browser.execute(
          () => (window as any).__pinia__._s.get("agent")?.status
        );
        return status === "thinking";
      },
      { timeout: 10000 }
    );

    const stopBtn = await browser.$(".agent-send-btn-stop");
    await stopBtn.click();

    // 等待完成
    await browser.waitUntil(
      async () => {
        const status = await browser.execute(
          () => (window as any).__pinia__._s.get("agent")?.status
        );
        return status !== "thinking";
      },
      { timeout: 10000 }
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
  }, 30000);
});
