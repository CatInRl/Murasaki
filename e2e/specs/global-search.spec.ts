/**
 * 统一搜索条 E2E 主链路测试（覆盖 0.8.0 搜索 spec 议题簇 0 / 2）
 *
 * 验证 spec「测试策略」L149 要求的 E2E 主链路：
 * - 快捷键拉起（Ctrl+P / Ctrl+Shift+F）→ 输入框自动聚焦
 * - 输入关键词 → 结果渲染
 * - 回车打开 → 文件在 tab 中打开
 * - Esc 关闭 → 搜索条消失（焦点还原由 App.vue onSearchClose 处理）
 *
 * 实现方式：
 * - 全局快捷键通过 window.dispatchEvent(keydown) 触发（对齐 shortcuts.spec.ts）
 * - 输入框按键（回车 / Esc）通过 input 元素 dispatchEvent 触发
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace } from "../helpers/fixtures";
import {
  openWorkspace,
  closeWorkspace,
  closeAllTabs,
  waitForPinia,
  dismissAllDialogs,
  ensureSplitMode,
  resetPersistenceSettings,
} from "../helpers/store";
import { resolve } from "node:path";

let browser: Browser;
let wsPath: string;

/** 通过 window.dispatchEvent 触发全局快捷键（App.vue onKeyDown 监听 window） */
async function pressShortcut(
  browser: Browser,
  key: string,
  opts: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}
): Promise<void> {
  await browser.execute((k: string, c: boolean, s: boolean, a: boolean, m: boolean) => {
    const ev = new KeyboardEvent("keydown", {
      key: k,
      bubbles: true,
      cancelable: true,
      ctrlKey: c,
      shiftKey: s,
      altKey: a,
      metaKey: m,
    });
    window.dispatchEvent(ev);
  }, key, !!opts.ctrl, !!opts.shift, !!opts.alt, !!opts.meta);
}

/** 在搜索条输入框上触发按键（回车 / Esc 等由 onInputKeydown 处理） */
async function pressOnInput(
  browser: Browser,
  key: string
): Promise<void> {
  await browser.execute((k: string) => {
    const input = document.querySelector<HTMLInputElement>(".gsb__input input");
    if (!input) throw new Error("搜索条输入框未找到");
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })
    );
  }, key);
}

/** 轮询等待搜索条 visible 状态 */
async function waitForSearchVisible(
  browser: Browser,
  visible: boolean,
  timeout = 5000
): Promise<void> {
  await browser.waitUntil(
    async () => {
      const v = await browser.execute(() => {
        // @ts-ignore
        return window.__pinia__._s.get("search")?.visible ?? false;
      });
      return v === visible;
    },
    { timeout, interval: 100 }
  );
}

describe("统一搜索条主链路", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  beforeEach(async () => {
    await resetPersistenceSettings(browser);
    wsPath = resetWorkspace([
      {
        path: "notes.md",
        content: "# 笔记\n\n这是待搜索的目标内容，含独特词 markdown-search-e2e。\n",
      },
      {
        path: "other.md",
        content: "# 其他\n\n不含目标词的普通文件。\n",
      },
    ]);
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
    await openWorkspace(browser, wsPath);
    await (await browser.$(".file-tree")).waitForExist({ timeout: 10000 });
    await ensureSplitMode(browser);
    await dismissAllDialogs(browser);
  });

  it("Ctrl+P 拉起搜索条且输入框自动聚焦", async () => {
    await pressShortcut(browser, "p", { ctrl: true });
    await waitForSearchVisible(browser, true);

    const gsb = await browser.$(".gsb");
    expect(await gsb.isExisting()).toBe(true);

    // 输入框应自动聚焦
    const focused = await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>(".gsb__input input");
      return input ? document.activeElement === input : false;
    });
    expect(focused).toBe(true);
  });

  it("Ctrl+Shift+F 同样拉起搜索条（find-in-files 重指向）", async () => {
    await pressShortcut(browser, "f", { ctrl: true, shift: true });
    await waitForSearchVisible(browser, true);
    const gsb = await browser.$(".gsb");
    expect(await gsb.isExisting()).toBe(true);
  });

  it("输入关键词 → 回车打开目标文件到新 tab", async () => {
    // 打开搜索条
    await pressShortcut(browser, "p", { ctrl: true });
    await waitForSearchVisible(browser, true);

    // 输入文件名关键词（前端文件名匹配，避免依赖 Rust 内容扫描时序）
    const input = await browser.$(".gsb__input input");
    await input.setValue("notes");
    await browser.pause(300);

    // 结果区出现文件名命中条目
    const items = await browser.$$(".gsb__item");
    const texts = await Promise.all(items.map((i) => i.getText()));
    expect(texts.some((t) => t.includes("notes.md"))).toBe(true);

    // 回车打开首项
    await pressOnInput(browser, "Enter");
    await browser.pause(500);

    // 搜索条关闭 + 目标文件已在 tab 打开
    await waitForSearchVisible(browser, false);
    const tabsState = await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      return {
        count: tabs.tabs.length,
        activePath: tabs.activeTab?.path ?? null,
      };
    });
    expect(tabsState.count).toBeGreaterThanOrEqual(1);
    expect((tabsState.activePath ?? "").replace(/\\/g, "/")).toContain("notes.md");
  });

  it("Esc 关闭搜索条（焦点还原由 App.vue 处理）", async () => {
    await pressShortcut(browser, "p", { ctrl: true });
    await waitForSearchVisible(browser, true);
    const gsb = await browser.$(".gsb");
    expect(await gsb.isExisting()).toBe(true);

    await pressOnInput(browser, "Escape");
    await waitForSearchVisible(browser, false);
    expect(await gsb.isExisting()).toBe(false);
  });
});
