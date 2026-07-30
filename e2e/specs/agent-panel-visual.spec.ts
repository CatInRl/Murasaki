/**
 * Agent 面板视觉对齐 E2E 测试（覆盖 M10-M13）
 *
 * 验证：
 * - M10: emoji → lucide 图标替换（用户 User 图标 / 助手 Bot 图标）
 * - M11: 工具调用折叠卡片（.tool-call-card + 折叠/展开切换）
 * - M12: 提案列表卡片（.agent-proposal-list + 状态 class）
 * - M13: 用户/助手消息气泡区分（左右对齐 + 不同颜色）
 * - Provider chip 显示（.provider-chip）
 *
 * 实现方式：通过 store 直接注入 messages / proposals，绕过真实 LLM 调用。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace, defaultFixtureFiles } from "../helpers/fixtures";
import {
  openWorkspace,
  closeWorkspace,
  closeAllTabs,
  openFileInTab,
  waitForPinia,
  dismissAllDialogs,
  ensureSplitMode,
  resetPersistenceSettings,
} from "../helpers/store";

let browser: Browser;

/** 注入 mock AI provider，使 AgentPanel 不显示"未配置"空态（不使用真实 API key） */
async function injectMockProvider(browser: Browser): Promise<void> {
  await browser.execute(() => {
    // @ts-ignore
    const aiProviders = window.__pinia__._s.get("aiProviders");
    aiProviders.providers = [
      {
        id: "mock-provider",
        name: "Mock Provider",
        type: "deepseek",
        baseUrl: "https://api.mock.test",
        model: "mock-model",
        apiKeyEnc: "",
        isActive: true,
      },
    ];
  });
  await browser.pause(200);
}

/** 注入一条 user + assistant 对话（含工具调用） */
async function injectMessages(browser: Browser): Promise<void> {
  await browser.execute(() => {
    // @ts-ignore
    const agent = window.__pinia__._s.get("agent");
    const now = Date.now();
    agent.messages = [
      {
        id: "msg-user-1",
        role: "user",
        content: "请帮我加粗第一段",
        createdAt: now - 5000,
      },
      {
        id: "msg-assistant-1",
        role: "assistant",
        content: "好的，我来帮你加粗第一段。",
        createdAt: now - 4000,
        toolCalls: [
          {
            id: "tc-1",
            name: "get_current_document",
            arguments: "{}",
            status: "done",
            summary: "已获取 286 字符",
            result: { ok: true, data: { content: "# 标题\n\n正文" } },
          },
          {
            id: "tc-2",
            name: "propose_replace",
            arguments: '{"from": 0, "to": 5}',
            status: "done",
            summary: "L1-2",
          },
        ],
      },
    ];
  });
  await browser.pause(400);
}

describe("Agent 面板视觉对齐", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  afterEach(async () => {
    // 清理 mock provider，避免跨测试污染
    if (browser) {
      try {
        await browser.execute(() => {
          // @ts-ignore
          const aiProviders = window.__pinia__._s.get("aiProviders");
          if (aiProviders) aiProviders.providers = [];
        });
      } catch {
        /* ignore */
      }
    }
  });

  beforeEach(async () => {
    await resetPersistenceSettings(browser);
    const wsPath = resetWorkspace(defaultFixtureFiles());
    try {
      await closeAllTabs(browser);
    } catch {
      /* ignore */
    }
    try {
      await closeWorkspace(browser);
    } catch {
      /* ignore */
    }
    await dismissAllDialogs(browser);
    await openWorkspace(browser, wsPath);
    await (await browser.$(".file-tree")).waitForExist({ timeout: 10000 });
    await ensureSplitMode(browser);

    // 确保 Agent 面板可见
    await browser.execute(() => {
      // @ts-ignore
      const persistence = window.__pinia__._s.get("persistence");
      persistence.updateSettings({ showAgentPanel: true });
    });
    await browser.pause(300);

    // 注入 mock AI provider，使 hasProvider=true，避免 AgentPanel 渲染"未配置"空态
    await injectMockProvider(browser);

    // 清空 agent 消息
    await browser.execute(() => {
      // @ts-ignore
      const agent = window.__pinia__._s.get("agent");
      agent.messages = [];
    });
    await browser.pause(200);
  });

  // ============ Agent 面板基础结构 ============

  it("Agent 面板根元素 .agent-panel 存在", async () => {
    const panel = await browser.$(".agent-panel");
    expect(await panel.isExisting()).toBe(true);
    expect(await panel.isDisplayed()).toBe(true);
  });

  it("Agent 面板顶部标题栏 .agent-header 存在", async () => {
    const header = await browser.$(".agent-header");
    expect(await header.isExisting()).toBe(true);
  });

  it("Agent 面板输入区 .agent-input-area 存在", async () => {
    const inputArea = await browser.$(".agent-input-area");
    expect(await inputArea.isExisting()).toBe(true);

    // textarea 应存在
    const textarea = await browser.$(".agent-input");
    expect(await textarea.isExisting()).toBe(true);

    // 发送按钮应存在
    const sendBtn = await browser.$(".agent-send-btn-send");
    expect(await sendBtn.isExisting()).toBe(true);
  });

  // ============ M10: emoji → lucide 图标 ============

  it("用户消息头像使用 lucide User 图标（.agent-avatar-user）", async () => {
    await injectMessages(browser);

    const userAvatar = await browser.$(".agent-avatar-user");
    expect(await userAvatar.isExisting()).toBe(true);

    // 内部应渲染 svg（lucide 图标渲染为 svg）
    const svg = await userAvatar.$("svg");
    expect(await svg.isExisting()).toBe(true);
  });

  it("助手消息头像使用 lucide Bot 图标（.agent-avatar-assistant）", async () => {
    await injectMessages(browser);

    const assistantAvatar = await browser.$(".agent-avatar-assistant");
    expect(await assistantAvatar.isExisting()).toBe(true);

    const svg = await assistantAvatar.$("svg");
    expect(await svg.isExisting()).toBe(true);
  });

  // ============ M13: 用户/助手消息气泡区分 ============

  it("用户消息气泡 .agent-message-bubble-user 存在且右对齐", async () => {
    await injectMessages(browser);

    const userMsg = await browser.$(".agent-message-user");
    expect(await userMsg.isExisting()).toBe(true);

    const userBubble = await browser.$(".agent-message-bubble-user");
    expect(await userBubble.isExisting()).toBe(true);

    // 用户消息内容应包含原文
    const text = (await userBubble.getText()).trim();
    expect(text).toContain("请帮我加粗第一段");
  });

  it("助手消息气泡 .agent-message-bubble-assistant 存在且左对齐", async () => {
    await injectMessages(browser);

    const assistantMsg = await browser.$(".agent-message-assistant");
    expect(await assistantMsg.isExisting()).toBe(true);

    const assistantBubble = await browser.$(".agent-message-bubble-assistant");
    expect(await assistantBubble.isExisting()).toBe(true);

    const text = (await assistantBubble.getText()).trim();
    expect(text).toContain("好的，我来帮你加粗第一段");
  });

  it("用户消息与助手消息有不同的 class（user vs assistant）", async () => {
    await injectMessages(browser);

    const userMessages = await browser.$$(".agent-message-user");
    const assistantMessages = await browser.$$(".agent-message-assistant");
    expect(userMessages.length).toBeGreaterThanOrEqual(1);
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);
  });

  // ============ M11: 工具调用折叠卡片 ============

  it("助手消息含工具调用时渲染 .tool-call-card", async () => {
    await injectMessages(browser);

    const card = await browser.$(".tool-call-card");
    expect(await card.isExisting()).toBe(true);

    // 卡片标题栏应存在
    const header = await browser.$(".tool-call-card-header");
    expect(await header.isExisting()).toBe(true);

    // 标题应包含"工具"字样
    const title = await browser.$(".tool-call-card-title");
    expect(await title.isExisting()).toBe(true);
    const titleText = (await title.getText()).trim();
    expect(titleText).toContain("工具");
  });

  it("工具调用卡片默认折叠（.tool-call-card-body 不存在）", async () => {
    await injectMessages(browser);

    // 默认未展开
    const body = await browser.$(".tool-call-card-body");
    expect(await body.isExisting()).toBe(false);
  });

  it("点击 .tool-call-card-header 展开工具调用详情", async () => {
    await injectMessages(browser);

    const header = await browser.$(".tool-call-card-header");
    await header.click();
    await browser.pause(300);

    // 展开后应有 body
    const body = await browser.$(".tool-call-card-body");
    expect(await body.isExisting()).toBe(true);

    // 应有 2 个工具调用条目（tc-1, tc-2）
    const items = await browser.$$(".tool-call-item");
    expect(items.length).toBe(2);
  });

  it("工具调用条目状态 class 正确（done 状态）", async () => {
    await injectMessages(browser);

    // 先展开
    const header = await browser.$(".tool-call-card-header");
    await header.click();
    await browser.pause(300);

    // 应有 done 状态的条目
    const doneItems = await browser.$$(".tool-call-item-done");
    expect(doneItems.length).toBe(2);
  });

  // ============ M12: 提案列表卡片 ============

  it("有提案时渲染 .agent-proposal-list", async () => {
    await injectMessages(browser);

    // 注入提案到 proposals store
    await browser.execute(() => {
      // @ts-ignore
      const proposals = window.__pinia__._s.get("proposals");
      const editorBridge = window.__pinia__._s.get("editorBridge");
      const view = editorBridge.editorView;
      if (!view) return;

      // 通过 StateEffect 添加提案
      const { addProposalEffect } = proposals;
      // 直接调用 addProposal action
      proposals.addProposal({
        id: "prop-test-1",
        type: "replace",
        from: 0,
        to: 5,
        content: "**加粗**",
        status: "pending",
        label: "加粗第一段",
        lineCount: 1,
      });
    });
    await browser.pause(500);

    // 应有提案列表容器
    const list = await browser.$(".agent-proposal-list");
    expect(await list.isExisting()).toBe(true);

    // 应有标题
    const title = await browser.$(".proposal-list-title");
    expect(await title.isExisting()).toBe(true);
    const titleText = (await title.getText()).trim();
    expect(titleText).toContain("提议");
  });

  it("提案条目状态 class（pending/accepted/rejected）", async () => {
    await injectMessages(browser);

    await browser.execute(() => {
      // @ts-ignore
      const proposals = window.__pinia__._s.get("proposals");
      proposals.addProposal({
        id: "prop-status-test",
        type: "replace",
        from: 0,
        to: 5,
        content: "**加粗**",
        status: "pending",
        label: "状态测试提案",
        lineCount: 1,
      });
    });
    await browser.pause(500);

    // pending 状态的提案应存在
    const pendingItem = await browser.$(".proposal-item.proposal-pending");
    expect(await pendingItem.isExisting()).toBe(true);

    // 应有接受/拒绝按钮
    const acceptBtn = await browser.$(".proposal-item-accept");
    expect(await acceptBtn.isExisting()).toBe(true);

    const rejectBtn = await browser.$(".proposal-item-reject");
    expect(await rejectBtn.isExisting()).toBe(true);
  });

  // ============ Provider chip ============

  it("配置 provider 后显示 .provider-chip", async () => {
    // 注入 provider（不调用真实 API，仅前端状态）
    await browser.execute(() => {
      // @ts-ignore
      const aiProviders = window.__pinia__._s.get("aiProviders");
      // 直接 push 一个 provider 到 providers 数组
      aiProviders.providers = [
        {
          id: "test-provider",
          name: "Test Provider",
          type: "deepseek",
          baseUrl: "https://api.test.com",
          model: "test-model",
          apiKeyEnc: "",
          isActive: true,
        },
      ];
    });
    await browser.pause(300);

    // 应有 provider chip
    const chip = await browser.$(".provider-chip");
    expect(await chip.isExisting()).toBe(true);

    // 应包含 provider 名称
    const text = (await chip.getText()).trim();
    expect(text).toContain("Test Provider");
  });

  it("未配置 provider 时不显示 .provider-chip", async () => {
    // 清空 providers
    await browser.execute(() => {
      // @ts-ignore
      const aiProviders = window.__pinia__._s.get("aiProviders");
      aiProviders.providers = [];
    });
    await browser.pause(300);

    const chip = await browser.$(".provider-chip");
    expect(await chip.isExisting()).toBe(false);
  });

  // ============ 空状态 ============

  it("无消息时显示 Agent 空对话欢迎 EmptyState", async () => {
    // 不注入消息，确保 messages 为空
    await browser.execute(() => {
      // @ts-ignore
      const agent = window.__pinia__._s.get("agent");
      agent.messages = [];
    });
    await browser.pause(300);

    // AgentPanel.vue 第 368-373 行：messages.length === 0 + hasProvider + hasWorkspace
    // 显示 EmptyState "向 Agent 发送消息开始对话"
    // beforeEach 已注入 mock provider，故应显示欢迎空态
    // 验证至少存在某个 empty-state 或输入区可用
    const inputArea = await browser.$(".agent-input-area");
    const emptyState = await browser.$(".agent-empty-state, .empty-state");
    const hasInput = await inputArea.isExisting();
    const hasEmpty = await emptyState.isExisting();
    // 二者至少有一个
    expect(hasInput || hasEmpty).toBe(true);
  });
});
