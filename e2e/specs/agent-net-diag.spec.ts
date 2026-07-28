/**
 * 验证 WebView 是否有外网访问能力
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";

const API_KEY = process.env.MURASAKI_E2E_API_KEY ?? "";

let browser: Browser;

describe("WebView 网络诊断", () => {
  beforeAll(async () => {
    browser = await createSession();
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  it("fetch DeepSeek API 能否连通", async () => {
    if (!API_KEY) return;
    const result = await browser.executeAsync(
      (key: string, done: (res: unknown) => void) => {
        fetch("https://api.deepseek.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "deepseek-v4-flash",
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 10,
          }),
        })
          .then((r) => r.json())
          .then((json) => done({ ok: true, model: json.model, choices: json.choices?.length }))
          .catch((err) => done({ ok: false, error: String(err) }));
      },
      API_KEY
    );
    console.log("[net-diag] fetch result:", JSON.stringify(result));
  }, 30000);
});
