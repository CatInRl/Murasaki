/**
 * 在浏览器中直接触发 sendMessage 并捕获完整的错误链路
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { setupActiveProvider, teardownActiveProvider, resetWorkspace, defaultFixtureFiles } from "../helpers/fixtures";
import { openWorkspace, openFileInTab } from "../helpers/store";

const API_KEY = process.env.MURASAKI_E2E_API_KEY ?? "";

let browser: Browser;

describe("sendMessage 直接调用诊断", () => {
  beforeAll(async () => {
    if (!API_KEY) return;
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

  it("直接调用 sendMessage 并等待 15s 捕获状态", async () => {
    if (!API_KEY) return;
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    // 等待上下文卡片
    const card = await browser.$(".agent-context-card");
    await card.waitForExist({ timeout: 10000 });

    // 直接通过 store 调用 sendMessage
    const startResult = await browser.executeAsync(
      (done: (res: unknown) => void) => {
        const agent = (window as any).__pinia__._s.get("agent");
        agent.sendMessage("hi").then(
          () => done({ status: agent.status, error: agent.errorMessage }),
          (err: unknown) => done({ error: String(err), status: agent.status }),
        );
      }
    );
    console.log("[send-diag] after sendMessage:", JSON.stringify(startResult));

    // 如果还在 thinking，等 15 秒
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const s = await browser.execute(() => {
        const agent = (window as any).__pinia__._s.get("agent");
        return { status: agent?.status, error: agent?.errorMessage, msgCount: agent?.messages?.length };
      });
      console.log(`[send-diag] poll ${i + 1}s:`, JSON.stringify(s));
      if (s.status !== "thinking") break;
    }
  }, 30000);
});
