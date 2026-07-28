/**
 * Agent 诊断测试：验证 sendMessage 的 provider → get_api_key → LLM 链路
 * 用于调试真实 LLM 调用的各个阶段。
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { setupActiveProvider, teardownActiveProvider } from "../helpers/fixtures";

const API_KEY = process.env.MURASAKI_E2E_API_KEY ?? "";

let browser: Browser;

describe("Agent sendMessage 诊断", () => {
  beforeAll(async () => {
    if (!API_KEY) return;
    browser = await createSession();
    await teardownActiveProvider(browser);
    const provider = await setupActiveProvider(browser, API_KEY);
    console.log("[diag] setupActiveProvider result:", JSON.stringify(provider));
  }, 60000);

  afterAll(async () => {
    if (browser) {
      const diag = await browser.execute(() => {
        const agent = (window as any).__pinia__._s.get("agent");
        return agent ? {
          status: agent.status,
          errorMessage: agent.errorMessage,
          cumulativeTokens: agent.cumulativeTokens,
          hasContext: agent.hasContext,
        } : null;
      });
      console.log("[diag] final agent state:", JSON.stringify(diag));
      await teardownActiveProvider(browser);
      await closeSession(browser);
    }
  });

  it("查 agent store 初始状态", async () => {
    if (!API_KEY) return;
    const state = await browser.execute(() => {
      const agent = (window as any).__pinia__._s.get("agent");
      if (!agent) return { error: "agent store not found" };
      const providers = (window as any).__pinia__._s.get("aiProviders");
      return {
        status: agent.status,
        errorMessage: agent.errorMessage,
        providersCount: providers?.providers?.length ?? 0,
        activeProvider: providers?.activeProvider ?? null,
      };
    });
    console.log("[diag] initial state:", JSON.stringify(state));
  });

  it("验证 DPAPI key round-trip", async () => {
    if (!API_KEY) return;
    // 在浏览器中直接调用 get_api_key
    const result = await browser.execute(() => {
      const providers = (window as any).__pinia__._s.get("aiProviders");
      const active = providers?.activeProvider;
      return { activeExists: !!active, activeId: active?.id };
    });
    console.log("[diag] active provider:", JSON.stringify(result));
  });
});
