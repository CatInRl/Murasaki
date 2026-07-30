/**
 * 设置窗口 E2E 测试（Ticket #80 / T8.3 / ADR-0009）
 *
 * 验证：
 * - 通过 Tauri 命令打开设置窗口（窗口句柄增加）
 * - 设置窗口能被关闭
 *
 * 设置窗口是独立的 Tauri 多窗口（settings.html），通过 windowHandles 切换。
 *
 * E2E 限制：第二个 WebView2 窗口无法加载 tauri://localhost/settings.html
 * （additional_browser_args 只注入了主窗口，第二个 WebView2 环境没有
 * tauri:// 协议注册）。因此 UI 交互测试（分类导航、保存按钮等）在 E2E
 * 中跳过，由单元测试（settingsLogic.test.ts）覆盖。
 *
 * 关键发现：invoke("open_settings") 的 Promise 不会 resolve（新窗口创建阻塞了
 * IPC ack），但窗口确实被创建了。所以用 executeAsync 发送 invoke 后立即 done()，
 * 然后轮询 getWindowHandles 检测新窗口。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { closeWorkspace, waitForPinia } from "../helpers/store";

let browser: Browser;
let mainHandle: string;

/**
 * 打开设置窗口或复用已存在的设置窗口。
 *
 * invoke("open_settings") 的 Promise 不会 resolve，所以用 executeAsync
 * 发送 invoke 后立即 done()。invoke 内部同步发送 IPC 消息。
 */
async function openSettingsWindow(): Promise<void> {
  // 如果设置窗口已存在，直接返回（复用）
  const handles = await browser.getWindowHandles();
  if (handles.length > 1) {
    return;
  }

  // 关键：invoke("open_settings") 的 IPC 消息需要时间发送，且 Promise 不会
  // resolve（新窗口创建阻塞了 ack）。用 setTimeout 延迟 done() 调用，让
  // JavaScript 事件循环有机会处理 invoke 的 IPC 消息发送。
  await browser.executeAsync((done: (res: unknown) => void) => {
    try {
      // @ts-ignore
      window.__TAURI_INTERNALS__.invoke("open_settings");
    } catch (e) {
      // 忽略
    }
    // 等待 1 秒让 IPC 消息发送和窗口创建
    setTimeout(() => done(null), 1000);
  });
  // 额外等待 Rust 侧窗口创建
  await browser.pause(1000);
}

/** 关闭设置窗口并切回主窗口 */
async function closeSettingsWindow(): Promise<void> {
  const handles = await browser.getWindowHandles();
  if (handles.length <= 1) return;

  const settingsHandle = handles.find((h) => h !== mainHandle);
  if (settingsHandle) {
    await browser.switchToWindow(settingsHandle);
    // 用 Tauri invoke 关闭窗口（fire-and-forget，不等 Promise）
    await browser.executeAsync((done: (res: unknown) => void) => {
      try {
        // @ts-ignore
        window.__TAURI_INTERNALS__.invoke("plugin:window|close", {
          label: "settings",
        });
      } catch (e) {
        // 忽略
      }
      done(null);
    });
  }

  // 等待窗口关闭
  await browser.waitUntil(async () => {
    const handles = await browser.getWindowHandles();
    return handles.length === 1;
  }, { timeout: 5000 });

  await browser.switchToWindow(mainHandle);
}

describe("设置窗口", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
    mainHandle = await browser.getWindowHandle();
  }, 60000);

  afterAll(async () => {
    // 关键：closeSession 之前必须关闭 settings 窗口，否则 WebView2 会保留
    // settings 窗口状态，导致下一个 spec 的新 session 连接到 settings 窗口
    // 而非主窗口（title="设置"，__pinia__ 不会暴露）
    if (browser) {
      try {
        const handles = await browser.getWindowHandles();
        if (handles.length > 1) {
          await closeSettingsWindow();
        }
      } catch { /* ignore */ }
      await closeSession(browser);
    }
  });

  beforeEach(async () => {
    // 关闭残留的设置窗口
    const handles = await browser.getWindowHandles();
    if (handles.length > 1) {
      try { await closeSettingsWindow(); } catch { /* ignore */ }
    }
    try { await browser.switchToWindow(mainHandle); } catch { /* ignore */ }
    try { await closeWorkspace(browser); } catch { /* ignore */ }
  });

  // 0.3.1 起 settings 改为单入口路由（index.html#settings），不再创建独立窗口。
  // 旧"多窗口"测试已废弃，新的单入口路由测试见下方 `open_settings 命令在主窗口内渲染设置页`。
  it.skip("通过 open_settings 命令打开设置窗口（旧多窗口行为，已废弃）", async () => {
    const handlesBefore = await browser.getWindowHandles();
    expect(handlesBefore.length).toBe(1);

    await openSettingsWindow();

    // 等待新窗口出现
    await browser.waitUntil(async () => {
      const handles = await browser.getWindowHandles();
      return handles.length > 1;
    }, { timeout: 10000 });

    const handlesAfter = await browser.getWindowHandles();
    expect(handlesAfter.length).toBe(2);

    // 验证新窗口不是主窗口
    const settingsHandle = handlesAfter.find((h) => h !== mainHandle);
    expect(settingsHandle).toBeDefined();
  });

  // E2E 限制：设置窗口的 WebView2 无法加载 tauri://localhost/settings.html
  // （additional_browser_args 只注入了主窗口）。以下 UI 交互测试由单元测试覆盖。
  it.skip("设置窗口包含三个分类导航", async () => {
    // 需要 settings window UI 加载，E2E 环境下不可用
  });

  it.skip("点击分类切换面板", async () => {
    // 需要 settings window UI 加载，E2E 环境下不可用
  });

  it.skip("保存按钮在无改动时禁用", async () => {
    // 需要 settings window UI 加载，E2E 环境下不可用
  });

  it.skip("设置窗口标题为「设置」", async () => {
    // 需要 settings window UI 加载，E2E 环境下不可用
  });

  it("open_settings 命令在主窗口内渲染设置页（单入口路由）", async () => {
    // 前序测试可能遗留 settingsVisible=true（旧测试断言多窗口会失败但仍渲染设置页）
    // 先重置：emit navigate 事件携带非 "settings" payload，触发 settingsVisible=false
    await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "navigate",
        payload: "editor",
      }).then(
        () => done(null),
        (err: unknown) => done(err ? String(err) : null)
      );
    });
    await browser.pause(300);

    // 验证初始无设置页 DOM
    expect(await (await browser.$(".settings-shell")).isExisting()).toBe(false);

    const handlesBefore = await browser.getWindowHandles();
    expect(handlesBefore.length).toBe(1);

    // 调用 open_settings 命令（单入口路由：在主窗口内通过 navigate 事件切换）
    await openSettingsWindow();

    // 设置页 DOM 应在主窗口内渲染
    const settingsShell = await browser.$(".settings-shell");
    await settingsShell.waitForExist({ timeout: 5000 });
    expect(await settingsShell.isExisting()).toBe(true);

    // 不应创建新窗口（单入口路由 vs 旧多窗口方案）
    const handlesAfter = await browser.getWindowHandles();
    expect(handlesAfter.length).toBe(1);

    // 清理：隐藏设置页，避免影响后续 spec（session 内残留 settingsVisible）
    await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "navigate",
        payload: "editor",
      }).then(
        () => done(null),
        (err: unknown) => done(err ? String(err) : null)
      );
    });
    await browser.pause(200);
  });
});
