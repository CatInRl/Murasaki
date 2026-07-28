/**
 * 回归测试：closeSession 不得孤立 tauri-driver
 *
 * 根因（修复前）：closeSession / createSession 重试 / setup.ts killStaleProcesses
 * 都会执行 `Stop-Process -Name msedgedriver -Force`。tauri-driver 只在启动时
 * spawn 一次 msedgedriver（main.rs L42-45），无法恢复。一旦 msedgedriver 被杀，
 * tauri-driver 永久孤立，后续所有 POST /session 失败（socket hang up / 10061）。
 *
 * 此 spec 在同一进程内连续做两轮 createSession → closeSession。
 * 修复前：第二轮 createSession 会因为 msedgedriver 已被第一轮 closeSession 杀掉
 *         而失败（孤立 + 预检抛错，或 socket hang up）。
 * 修复后：两轮都成功，msedgedriver 全程存活。
 */
import { describe, it, expect, afterAll } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";

describe("driver 复用回归：连续两轮 createSession/closeSession", () => {
  let browser1: Browser | null = null;
  let browser2: Browser | null = null;

  afterAll(async () => {
    if (browser1) await closeSession(browser1).catch(() => {});
    if (browser2) await closeSession(browser2).catch(() => {});
  });

  it("第一轮 session 创建成功", async () => {
    browser1 = await createSession();
    const title = await browser1.getTitle();
    // 不强求标题内容（欢迎页 spec 已覆盖），只验证 session 可用
    expect(typeof title).toBe("string");
  }, 60000);

  it("第二轮 session 仍能创建（msedgedriver 未被孤立）", async () => {
    // 关闭第一轮，触发 closeSession（旧实现会在这里杀 msedgedriver）
    if (browser1) {
      await closeSession(browser1);
      browser1 = null;
    }
    // 关键断言：第二轮 createSession 不应抛错。
    // 旧实现：closeSession 杀了 msedgedriver → 预检或 POST 失败。
    // 新实现：closeSession 只杀 murasaki，msedgedriver 存活，第二轮成功。
    browser2 = await createSession();
    const title = await browser2.getTitle();
    expect(typeof title).toBe("string");
  }, 60000);
});
