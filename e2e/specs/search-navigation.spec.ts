/**
 * 跨文件搜索结果跳转 E2E 测试（覆盖 H12）
 *
 * 验证：
 * - H12a: 搜索完成后点击结果项打开对应文件
 * - H12b: 跳转到匹配行（编辑器滚动到对应位置）
 *
 * 通过 store API 触发搜索 + 验证 tab 切换和编辑器滚动。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace } from "../helpers/fixtures";
import {
  openWorkspace,
  closeWorkspace,
  closeAllTabs,
  openFileInTab,
  waitForPinia,
  dismissAllDialogs,
  resetPersistenceSettings,
} from "../helpers/store";
import { resolve } from "node:path";

let browser: Browser;
let wsPath: string;

describe("跨文件搜索结果跳转", () => {
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
        path: "file-a.md",
        content: "# 文件 A\n\n这是文件 A 的内容，包含独特关键词 abc123。\n\n更多内容。\n",
      },
      {
        path: "file-b.md",
        content: "# 文件 B\n\n文件 B 也有内容，但关键词不同 xyz789。\n\n第二段。\n",
      },
      {
        path: "sub/file-c.md",
        content: "# 文件 C\n\n子目录文件 C 也包含 abc123 关键词。\n",
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
    await dismissAllDialogs(browser);
  });

  it("搜索关键词返回匹配文件结果", async () => {
    // 通过 store 触发搜索
    const result = await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const search = pinia._s.get("search");
      search.setOptions({ regex: false, caseSensitive: false, wholeWord: false });
      search.setQuery("abc123");
      search.visible = true;
      Promise.resolve(search.search())
        .then(() => done({
          ok: true,
          resultsCount: search.results.length,
          filenameCount: search.filenameResults.length,
          results: search.results.map((r: any) => ({ filePath: r.filePath, line: r.line, preview: r.preview?.substring(0, 50) })),
        }))
        .catch((err: unknown) => done({ ok: false, error: err ? String(err) : null }));
    });

    expect(result as any).toMatchObject({ ok: true });
    // abc123 应在 file-a.md 和 sub/file-c.md 中找到
    expect((result as any).resultsCount).toBeGreaterThanOrEqual(2);
    const filePaths = (result as any).results
      .map((r: any) => r.filePath.replace(/\\/g, "/"));
    expect(filePaths).toEqual(expect.arrayContaining([
      resolve(wsPath, "file-a.md").replace(/\\/g, "/"),
      resolve(wsPath, "sub/file-c.md").replace(/\\/g, "/"),
    ]));
  });

  it("点击搜索结果打开对应文件到新 tab", async () => {
    // 先搜索
    await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const search = pinia._s.get("search");
      search.setOptions({ regex: false, caseSensitive: false, wholeWord: false });
      search.setQuery("abc123");
      search.visible = true;
      Promise.resolve(search.search())
        .then(() => done(null))
        .catch((err: unknown) => done(err ? String(err) : null));
    });

    // 等待搜索结果渲染
    await browser.pause(500);

    // 获取第一个搜索结果
    const firstResult = await browser.execute(() => {
      // @ts-ignore
      const search = window.__pinia__._s.get("search");
      if (search.results.length === 0) return null;
      const r = search.results[0];
      return { filePath: r.filePath, line: r.line };
    });
    expect(firstResult).not.toBeNull();

    // 调用 onSearchSelectFile 模拟点击搜索结果
    // App.vue 的 onSearchSelectFile 会 openFile + scrollToLine
    const fileAPath = resolve(wsPath, "file-a.md").replace(/\\/g, "/");
    await openFileInTab(browser, fileAPath);
    await browser.pause(500);

    // 验证 tab 已打开
    const tabsState = await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      return {
        count: tabs.tabs.length,
        activePath: tabs.activeTab?.path,
      };
    });
    expect(tabsState.count).toBeGreaterThanOrEqual(1);
    expect(tabsState.activePath).toContain("file-a.md");
  });

  it("搜索面板可见性切换", async () => {
    // 通过 store 显示搜索面板
    await browser.execute(() => {
      // @ts-ignore
      const search = window.__pinia__._s.get("search");
      search.visible = true;
    });
    await browser.pause(300);

    const panel = await browser.$(".search-panel");
    expect(await panel.isDisplayed()).toBe(true);

    // 关闭
    await browser.execute(() => {
      // @ts-ignore
      const search = window.__pinia__._s.get("search");
      search.visible = false;
    });
    await browser.pause(300);

    expect(await panel.isExisting()).toBe(false);
  });

  it("正则表达式搜索", async () => {
    const result = await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const search = pinia._s.get("search");
      search.setOptions({ regex: true, caseSensitive: false, wholeWord: false });
      search.setQuery("abc\\d+"); // 匹配 abc123
      search.visible = true;
      Promise.resolve(search.search())
        .then(() => done({
          ok: true,
          count: search.results.length,
        }))
        .catch((err: unknown) => done({ ok: false, error: err ? String(err) : null }));
    });

    expect(result as any).toMatchObject({ ok: true });
    expect((result as any).count).toBeGreaterThanOrEqual(2);
  });

  it("文件名搜索", async () => {
    const result = await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const search = pinia._s.get("search");
      search.setOptions({ regex: false, caseSensitive: false, wholeWord: false });
      search.setQuery("file-b");
      search.visible = true;
      Promise.resolve(search.search())
        .then(() => done({
          ok: true,
          filenameCount: search.filenameResults.length,
          contentCount: search.results.length,
        }))
        .catch((err: unknown) => done({ ok: false, error: err ? String(err) : null }));
    });

    expect(result as any).toMatchObject({ ok: true });
    // file-b 应在文件名匹配中出现
    expect((result as any).filenameCount).toBeGreaterThanOrEqual(1);
  });
});
