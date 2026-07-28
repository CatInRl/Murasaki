/**
 * Agent 对话持久化 E2E 测试（E 层）
 *
 * 验收标准：
 * - sendMessage 后关 session 重建 → 消息还在
 * - clearConversation 后消息消失 + chat 文件删除
 *
 * 需要有效的 MURASAKI_E2E_API_KEY 环境变量。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace, defaultFixtureFiles, setupActiveProvider, teardownActiveProvider } from "../helpers/fixtures";
import { openWorkspace, closeWorkspace } from "../helpers/store";

const API_KEY = process.env.MURASAKI_E2E_API_KEY ?? "";

let browser: Browser;

describe("Agent 对话持久化", () => {
  let wpPath: string;

  beforeAll(async () => {
    if (!API_KEY) return;
    wpPath = resetWorkspace(defaultFixtureFiles());
    browser = await createSession();
    await teardownActiveProvider(browser);
    await setupActiveProvider(browser, API_KEY);
  }, 60000);

  afterAll(async () => {
    if (browser) {
      await teardownActiveProvider(browser);
      await closeSession(browser);
    }
  });

  it("sendMessage 后重建 session 对话不丢失", async () => {
    if (!API_KEY) {
      console.warn("跳过：未设置 MURASAKI_E2E_API_KEY");
      return;
    }
    await openWorkspace(browser, wpPath);
    
    // 发送一条消息
    const card = await browser.$(".agent-context-card");
    await card.waitForExist({ timeout: 10000 });
    
    const input = await browser.$(".agent-input");
    await input.setValue("记住：今天的测试密钥是 Murasaki2026");
    
    const sendBtn = await browser.$(".agent-send-btn-send");
    await sendBtn.click();

    await browser.waitUntil(
      async () => {
        const status = await browser.execute(
          () => (window as any).__pinia__._s.get("agent")?.status
        );
        return status === "done" || status === "error";
      },
      { timeout: 30000 }
    );

    // 记录消息数量
    const msgCount1 = await browser.execute(
      () => (window as any).__pinia__._s.get("agent")?.messages?.length ?? 0
    );
    expect(msgCount1).toBeGreaterThanOrEqual(1);

    // 等待 500ms debounce 保存完成
    await browser.pause(1000);

    // 关闭 session，重新打开
    await closeSession(browser);
    await browser.pause(2000);
    browser = await createSession();

    // 恢复 provider
    await teardownActiveProvider(browser);
    await setupActiveProvider(browser, API_KEY);

    // 重新打开工作区
    await openWorkspace(browser, wpPath);

    // 等待加载
    await browser.pause(2000);

    // 验证消息还在
    const msgCount2 = await browser.execute(
      () => (window as any).__pinia__._s.get("agent")?.messages?.length ?? 0
    );
    expect(msgCount2).toBeGreaterThanOrEqual(1);
  }, 60000);

  it("clearConversation 后消息消失", async () => {
    if (!API_KEY) {
      console.warn("跳过：未设置 MURASAKI_E2E_API_KEY");
      return;
    }
    await openWorkspace(browser, wpPath);
    
    // 清空对话
    await browser.execute(() => {
      // @ts-ignore
      const agent = window.__pinia__._s.get("agent");
      if (agent) agent.clearConversation();
    });
    await browser.pause(1000);

    // 验证消息为空
    const msgCount = await browser.execute(
      () => (window as any).__pinia__._s.get("agent")?.messages?.length ?? 0
    );
    expect(msgCount).toBe(0);

    // 关闭 session 重建
    await closeSession(browser);
    await browser.pause(2000);
    browser = await createSession();

    await teardownActiveProvider(browser);
    await setupActiveProvider(browser, API_KEY);
    await openWorkspace(browser, wpPath);
    await browser.pause(2000);

    // 验证消息仍为空（持久化也被清掉了）
    const msgCount2 = await browser.execute(
      () => (window as any).__pinia__._s.get("agent")?.messages?.length ?? 0
    );
    expect(msgCount2).toBe(0);
  }, 45000);
});
