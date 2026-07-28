/**
 * Agent LLM 调用循环 E2E 测试（C 层）
 *
 * 验收标准：
 * - sendMessage 后 status 从 thinking 变为 done
 * - messages 新增 assistant 消息
 * - streamingContent 非空（流式 token）
 * - 工具调用条目出现（若 LLM 发出 tool call）
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

describe("Agent LLM 调用循环", () => {
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
    // 清空对话
    await browser.execute(() => {
      // @ts-ignore
      const agent = window.__pinia__._s.get("agent");
      if (agent) agent.clearConversation();
    });
    // 注入 provider
    await teardownActiveProvider(browser);
    await setupActiveProvider(browser, API_KEY);
  });

  it("sendMessage 发送简单问候后拿到 assistant 回复", async () => {
    if (!API_KEY) {
      console.warn("跳过：未设置 MURASAKI_E2E_API_KEY");
      return;
    }
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    // 等待上下文卡片出现
    const card = await browser.$(".agent-context-card");
    await card.waitForExist({ timeout: 10000 });

    // 输入消息并发送
    const input = await browser.$(".agent-input");
    await input.setValue("你好，请用一句话介绍自己");
    
    const sendBtn = await browser.$(".agent-send-btn-send");
    await sendBtn.click();

    // 等待 thinking 变为 done（最长 30s）
    await browser.waitUntil(
      async () => {
        const status = await browser.execute(
          () => (window as any).__pinia__._s.get("agent")?.status
        );
        return status === "done" || status === "error";
      },
      { timeout: 30000, timeoutMsg: "Agent 未在 30s 内完成" }
    );

    // 验证状态为 done
    const finalStatus = await browser.execute(
      () => (window as any).__pinia__._s.get("agent")?.status
    );
    expect(finalStatus).toBe("done");

    // 验证有 assistant 消息
    const messages = await browser.execute(
      () => (window as any).__pinia__._s.get("agent")?.messages
    );
    const assistantMsgs = (messages as any[]).filter((m: any) => m.role === "assistant");
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
  }, 45000);

  it("sendMessage 后工具调用可见", async () => {
    if (!API_KEY) {
      console.warn("跳过：未设置 MURASAKI_E2E_API_KEY");
      return;
    }
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    const card = await browser.$(".agent-context-card");
    await card.waitForExist({ timeout: 10000 });

    // 发送需要工具调用的问题
    const input = await browser.$(".agent-input");
    await input.setValue("请使用工具查看当前打开的文件内容，然后告诉我文件标题是什么");
    
    const sendBtn = await browser.$(".agent-send-btn-send");
    await sendBtn.click();

    await browser.waitUntil(
      async () => {
        const status = await browser.execute(
          () => (window as any).__pinia__._s.get("agent")?.status
        );
        return status === "done" || status === "error";
      },
      { timeout: 45000, timeoutMsg: "Agent 未在 45s 内完成" }
    );

    // 验证有工具调用条目（至少 calling 或 done 状态）
    const toolEntries = await browser.$$(".tool-call-entry");
    expect(toolEntries.length).toBeGreaterThanOrEqual(1);
  }, 60000);
});
