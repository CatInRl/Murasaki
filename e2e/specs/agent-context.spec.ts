/**
 * Agent 上下文 + 工具调用可见性 E2E 测试（Ticket #21）
 *
 * 验收标准：
 * - 上下文卡片在有文档路径时显示
 * - 点「×」移除当前文档上下文后该轮不附带
 * - 切 tab 时上下文跟随活跃 tab
 * - 工具调用条目可见（调用中/完成/失败状态）
 * - 非法 arguments 时错误回填给 LLM
 *
 * 不发起真实 LLM 请求：直接通过 store action 验证 UI 行为。
 * 工具调用可见性通过直接构造 messages 数组验证（绕过 LLM 流式）。
 *
 * T4.1 更新：工具调用现在在折叠卡片内，需先点击 .tool-call-card-header 展开。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace, defaultFixtureFiles, setupActiveProvider, teardownActiveProvider } from "../helpers/fixtures";
import { openWorkspace, closeWorkspace, openFileInTab, dismissAllDialogs, closeAllTabs } from "../helpers/store";

let browser: Browser;

// 工具调用可见性测试需要 provider 配置才能渲染对话区
// （AgentPanel 在 showNoProvider=true 时显示"未配置 AI 服务"空状态，遮挡消息列表）
const API_KEY = process.env.MURASAKI_E2E_API_KEY ?? "";

describe("Agent 上下文 + 工具调用可见性", () => {
  beforeAll(async () => {
    browser = await createSession();
  }, 60000);

  afterAll(async () => {
    if (browser) {
      try { await teardownActiveProvider(browser); } catch { /* ignore */ }
      await closeSession(browser);
    }
  });

  beforeEach(async () => {
    resetWorkspace(defaultFixtureFiles());
    // 关闭所有 tabs（避免 dirty tab 触发 unsaved dialog 遮挡点击）
    try { await closeAllTabs(browser); } catch { /* ignore */ }
    try {
      await closeWorkspace(browser);
    } catch {
      // 首次启动无工作区
    }
    // 关闭前序 spec 残留的 dialog / toast（dialog-overlay 会遮挡点击）
    await dismissAllDialogs(browser);
    // 清空 agent 对话
    await browser.execute(() => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const agent = pinia._s.get("agent");
      if (agent) agent.clearConversation();
    });
    // 配置 provider，确保 AgentPanel 渲染对话区而非"未配置 AI 服务"空状态
    // 工具调用可见性测试（test 6/7/8）依赖对话区渲染
    try { await teardownActiveProvider(browser); } catch { /* ignore */ }
    if (API_KEY) {
      try {
        await setupActiveProvider(browser, API_KEY);
        // 验证 provider 已配置
        const hasProvider = await browser.execute(() => {
          // @ts-ignore
          return window.__pinia__._s.get("aiProviders").hasProvider;
        });
        console.log(`[beforeEach] setupActiveProvider ok, hasProvider=${hasProvider}`);
      } catch (err) {
        console.error(`[beforeEach] setupActiveProvider failed:`, err instanceof Error ? err.message : String(err));
        throw err;
      }
    } else {
      console.warn(`[beforeEach] API_KEY is empty, skipping provider setup`);
    }
  });

  it("无工作区时显示「打开工作区后启用 Agent」空状态", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await closeWorkspace(browser);

    const empty = await browser.$(".agent-empty-state .empty-title");
    await empty.waitForExist({ timeout: 10000 });
    const text = (await empty.getText()).trim();
    expect(text).toBe("打开工作区后启用 Agent");
  });

  it("打开文件后上下文卡片显示文档路径", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    // 上下文卡片应显示
    const card = await browser.$(".agent-context-card");
    await card.waitForExist({ timeout: 10000 });
    expect(await card.isDisplayed()).toBe(true);

    const pathEl = await browser.$(".agent-context-path");
    const pathText = (await pathEl.getText()).trim();
    expect(pathText).toContain("intro.md");
  });

  it("上下文卡片显示 token 数估算", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    const tokensEl = await browser.$(".agent-context-tokens");
    await tokensEl.waitForExist({ timeout: 10000 });
    const text = (await tokensEl.getText()).trim();
    // 格式：≈ N tokens
    expect(text).toMatch(/≈\s*\d+\s*tokens/);
  });

  it("点「×」移除当前文档上下文后卡片消失", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    const card = await browser.$(".agent-context-card");
    await card.waitForExist({ timeout: 10000 });
    expect(await card.isDisplayed()).toBe(true);

    const removeBtn = await browser.$(".agent-context-remove");
    await removeBtn.click();

    // 卡片应该消失
    await card.waitForExist({ timeout: 5000, reverse: true });
  });

  it("切 tab 时上下文跟随活跃 tab 路径变化", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);

    // 打开两个文件
    await openFileInTab(browser, `${wsPath}\\intro.md`);
    await openFileInTab(browser, `${wsPath}\\notes.md`);

    // 当前激活的是 notes.md（最后打开的）
    const pathEl1 = await browser.$(".agent-context-path");
    await pathEl1.waitForExist({ timeout: 10000 });
    const text1 = (await pathEl1.getText()).trim();
    expect(text1).toContain("notes.md");

    // 通过 store 切换到 intro.md tab
    await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const tabs = pinia._s.get("tabs");
      const introTab = tabs.tabs.find((t: { path: string | string[] }) =>
        t.path?.includes("intro.md")
      );
      if (introTab) {
        tabs.activeTabId = introTab.id;
      }
      done(null);
    });

    // 等待 Vue 响应式更新
    await browser.pause(200);
    const pathEl2 = await browser.$(".agent-context-path");
    const text2 = (await pathEl2.getText()).trim();
    expect(text2).toContain("intro.md");
  });

  it("工具调用条目按调用中/完成状态显示", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    // provider 已在 beforeEach 中通过 setupActiveProvider 配置，
    // AgentPanel 渲染对话区而非"未配置 AI 服务"空状态。

    // 调试：检查 AgentPanel 状态
    const debugState = await browser.execute(() => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const aiProviders = pinia._s.get("aiProviders");
      const workspace = pinia._s.get("workspace");
      const persistence = pinia._s.get("persistence");
      const agent = pinia._s.get("agent");
      return {
        hasProvider: aiProviders.hasProvider,
        hasWorkspace: workspace.hasWorkspace,
        showAgentPanel: persistence?.settings?.showAgentPanel,
        messagesLen: agent.messages.length,
        isLoading: agent.isLoading,
      };
    });
    console.log("[debug] AgentPanel state:", JSON.stringify(debugState));

    // 等待 agent store 完成从磁盘加载对话（loadChatFromDisk 是异步的，
    // 会覆盖 messages.value，必须在 push 前等待完成）
    await browser.waitUntil(async () => {
      const loading = await browser.execute(() => {
        // @ts-ignore
        return window.__pinia__._s.get("agent").isLoading;
      });
      return loading === false;
    }, { timeout: 5000, interval: 100 });
    console.log("[debug] agent.isLoading is now false");

    // 直接构造一条带工具调用的 assistant 消息
    await browser.execute(() => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const agent = pinia._s.get("agent");
      agent.messages.push({
        id: "test-msg-1",
        role: "assistant",
        content: "正在调用工具...",
        createdAt: Date.now(),
        toolCalls: [
          {
            id: "tc-1",
            name: "get_current_document",
            arguments: "{}",
            status: "calling",
          },
          {
            id: "tc-2",
            name: "get_selection",
            arguments: "{}",
            status: "done",
            summary: "已获取 0 字符选区",
            result: { ok: true, data: null },
            parsedArgs: {},
          },
        ],
      });
    });

    // 调试：检查消息是否推入
    const msgCount = await browser.execute(() => {
      // @ts-ignore
      return window.__pinia__._s.get("agent").messages.length;
    });
    console.log(`[debug] messages count after push: ${msgCount}`);

    // 调试：检查消息的 toolCalls 字段
    const msgDebug = await browser.execute(() => {
      // @ts-ignore
      const agent = window.__pinia__._s.get("agent");
      const msg = agent.messages[0];
      if (!msg) return { msgExists: false };
      return {
        msgExists: true,
        role: msg.role,
        hasToolCalls: !!msg.toolCalls,
        toolCallsLen: msg.toolCalls?.length,
        toolCallsType: typeof msg.toolCalls,
        isArray: Array.isArray(msg.toolCalls),
        keys: Object.keys(msg),
      };
    });
    console.log("[debug] message object:", JSON.stringify(msgDebug));

    // 调试：检查 AgentPanel 渲染了什么
    await browser.pause(500);
    const panelDebug = await browser.execute(() => {
      const panel = document.querySelector(".agent-panel");
      if (!panel) return { panelExists: false };
      const emptyStates = panel.querySelectorAll(".agent-empty-state");
      const conversations = panel.querySelectorAll(".agent-conversation");
      const messages = panel.querySelectorAll(".agent-message");
      const assistantMsgs = panel.querySelectorAll(".agent-message-assistant");
      const toolCards = panel.querySelectorAll(".tool-call-card");
      const headers = panel.querySelectorAll(".tool-call-card-header");
      const assistantEl = assistantMsgs[0];
      return {
        panelExists: true,
        emptyStateCount: emptyStates.length,
        conversationCount: conversations.length,
        messageCount: messages.length,
        assistantMsgCount: assistantMsgs.length,
        toolCardCount: toolCards.length,
        headerCount: headers.length,
        assistantInnerHTML: assistantEl ? assistantEl.innerHTML.substring(0, 800) : null,
      };
    });
    console.log("[debug] panel render:", JSON.stringify(panelDebug));

    // 展开工具调用折叠卡片（T4.1: 条目在折叠卡片内，需先展开）
    // 注意：messages.push 后 Vue 异步渲染，需 waitForExist 等待卡片挂载
    const cardHeader1 = await browser.$(".tool-call-card-header");
    await cardHeader1.waitForExist({ timeout: 5000 });
    await cardHeader1.click();
    await browser.pause(200);

    // 工具调用条目应可见
    const entries = await browser.$$(".tool-call-entry");
    expect(entries.length).toBeGreaterThanOrEqual(2);

    // 第一个应为 calling 状态
    const callingEntry = await browser.$(".tool-call-calling");
    expect(await callingEntry.isDisplayed()).toBe(true);

    // 第二个应为 done 状态
    const doneEntry = await browser.$(".tool-call-done");
    expect(await doneEntry.isDisplayed()).toBe(true);

    // 调用中状态显示「调用中...」
    const callingSummary = await browser.$(".tool-call-calling .tool-call-summary");
    const summaryText = (await callingSummary.getText()).trim();
    expect(summaryText).toBe("调用中...");
  });

  it("点击工具调用折叠卡片展开参数和结果", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    // provider 已在 beforeEach 中配置

    await browser.execute(() => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const agent = pinia._s.get("agent");
      agent.messages.push({
        id: "test-msg-2",
        role: "assistant",
        content: "",
        createdAt: Date.now(),
        toolCalls: [
          {
            id: "tc-expand",
            name: "get_current_document",
            arguments: "{}",
            status: "done",
            summary: "已获取 100 字符",
            result: { ok: true, data: { content: "test content" } },
            parsedArgs: {},
          },
        ],
      });
    });

    // 初始状态下详情不应可见（卡片折叠，条目未渲染）
    const detailBefore = await browser.$(".tool-call-detail");
    expect(await detailBefore.isExisting()).toBe(false);

    // 点击卡片头部展开（T4.1: 折叠卡片整体展开）
    const cardHeader2 = await browser.$(".tool-call-card-header");
    await cardHeader2.waitForExist({ timeout: 5000 });
    await cardHeader2.click();

    // 详情应可见
    const detailAfter = await browser.$(".tool-call-detail");
    await detailAfter.waitForExist({ timeout: 5000 });
    expect(await detailAfter.isDisplayed()).toBe(true);

    // 应包含「参数:」标签
    const label = await browser.$(".tool-call-detail .tool-call-label");
    const labelText = (await label.getText()).trim();
    expect(labelText).toBe("参数:");
  });

  it("工具调用失败状态显示错误信息", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    // provider 已在 beforeEach 中配置

    await browser.execute(() => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const agent = pinia._s.get("agent");
      agent.messages.push({
        id: "test-msg-3",
        role: "assistant",
        content: "",
        createdAt: Date.now(),
        toolCalls: [
          {
            id: "tc-error",
            name: "get_outline",
            arguments: "{}",
            status: "error",
            summary: "No file path",
            result: { ok: false, error: "No file path" },
            parsedArgs: {},
          },
        ],
      });
    });

    // 展开工具调用折叠卡片（T4.1: 条目在折叠卡片内，需先展开）
    const cardHeader3 = await browser.$(".tool-call-card-header");
    await cardHeader3.waitForExist({ timeout: 5000 });
    await cardHeader3.click();
    await browser.pause(200);

    const errorEntry = await browser.$(".tool-call-error");
    expect(await errorEntry.isDisplayed()).toBe(true);

    const summary = await browser.$(".tool-call-error .tool-call-summary");
    const text = (await summary.getText()).trim();
    expect(text).toContain("No file path");
  });

  it("非法 arguments 时工具结果含 invalid_json 错误", async () => {
    // 通过直接调用 executeTool 验证（绕过 LLM 调用）
    const result = await browser.executeAsync(
      (done: (res: unknown) => void) => {
        // @ts-ignore
        const agentTools = window.__agentTools__;
        const ctx = {
          getEditorView: () => null,
          getDocPath: () => null,
          getWorkspacePath: () => null,
        };
        agentTools.executeTool("get_current_document", "{invalid json", ctx)
          .then((res) => done(res))
          .catch((err: unknown) => done({ error: String(err) }));
      }
    ) as { result: { ok: boolean; error?: string }; summary: string; parsedArgs: { _error: string } };

    expect(result.result.ok).toBe(false);
    expect(result.result.error).toBe("invalid_json");
    expect(result.summary).toContain("JSON 解析失败");
    expect(result.parsedArgs._error).toBe("invalid_json");
  });
});
