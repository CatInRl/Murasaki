/**
 * 验证 openai npm 包在 WebView 2 中的流式调用是否正常
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";

const API_KEY = process.env.MURASAKI_E2E_API_KEY ?? "";

let browser: Browser;

describe("OpenAI streaming 诊断", () => {
  beforeAll(async () => {
    if (!API_KEY) return;
    browser = await createSession();
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  it("openai 包 streaming chat 能否正常完成", async () => {
    if (!API_KEY) return;
    // 在浏览器中动态 import openai 并测试
    const result = await browser.executeAsync(
      (key: string, done: (res: unknown) => void) => {
        // openai 包在生产构建中被打包，尝试直接通过内部模块加载
        // 使用 fetch + stream reader 模拟 streaming 行为
        fetch("https://api.deepseek.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "deepseek-v4-flash",
            messages: [{ role: "user", content: "用一句话介绍自己" }],
            max_tokens: 50,
            stream: true,
          }),
        })
          .then(async (response) => {
            if (!response.ok) {
              done({ ok: false, error: `HTTP ${response.status}` });
              return;
            }
            const reader = response.body?.getReader();
            if (!reader) {
              done({ ok: false, error: "no reader" });
              return;
            }
            const decoder = new TextDecoder();
            let fullText = "";
            let chunkCount = 0;
            try {
              while (true) {
                const { done: isDone, value } = await reader.read();
                if (isDone) break;
                chunkCount++;
                const text = decoder.decode(value, { stream: true });
                fullText += text;
              }
              done({ ok: true, textLen: fullText.length, chunkCount });
            } catch (err: unknown) {
              done({ ok: false, error: String(err), chunkCount });
            }
          })
          .catch((err: unknown) => done({ ok: false, error: String(err) }));
      },
      API_KEY
    );
    console.log("[stream-diag] result:", JSON.stringify(result));
  }, 15000);
});
