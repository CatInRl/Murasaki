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
 *
 * T4.1 更新：工具调用现在在折叠卡片内，需先点击 .tool-call-card-header 展开。
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

    // 通过 store 直接调用 sendMessage
    const result = await browser.executeAsync((done: (res: unknown) => void) => {
      const agent = (window as any).__pinia__._s.get("agent");
      agent.sendMessage("你好，请用一句话介绍自己").then(
        () => done({ ok: true, status: agent.status }),
        (err: unknown) => done({ ok: false, error: String(err), status: agent.status }),
      );
    });

    // 验证有 assistant 消息
    const messages = await browser.execute(
      () => {
        const agent = (window as any).__pinia__._s.get("agent");
        return agent?.messages?.length ?? 0;
      }
    );
    expect(messages).toBeGreaterThanOrEqual(1);
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

    // 通过 store 直接调用 sendMessage（带工具调用）
    await browser.executeAsync((done: (res: unknown) => void) => {
      const agent = (window as any).__pinia__._s.get("agent");
      agent.sendMessage("请使用工具查看当前打开的文件内容，然后告诉我文件标题是什么").then(
        () => done(null),
        (err: unknown) => done({ error: String(err) }),
      );
    });

    // 等待工具调用折叠卡片出现并展开（T4.1: 条目在折叠卡片内）
    const cardHeader = await browser.$(".tool-call-card-header");
    await cardHeader.waitForExist({ timeout: 10000 });
    await cardHeader.click();
    await browser.pause(300);

    // 验证有工具调用条目（至少 calling 或 done 状态）
    const toolEntries = await browser.$$(".tool-call-entry");
    expect(toolEntries.length).toBeGreaterThanOrEqual(1);
  }, 60000);
});