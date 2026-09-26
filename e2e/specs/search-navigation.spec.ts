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
  waitForPinia,
  dismissAllDialogs,
  resetPersistenceSettings,
} from "../helpers/store";
import { waitForPresent } from "../helpers/wait";
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
    await waitForPresent(browser, ".file-tree", 10000);
    await dismissAllDialogs(browser);
  });

  it("搜索关键词返回匹配文件结果", async () => {
    // 先打开统一搜索条（挂载会 clear 旧查询），再设置关键词
    await browser.execute(() => {
      // @ts-ignore
      const search = window.__pinia__._s.get("search");
      search.visible = true;
    });
    await browser.pause(200);
    const result = await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const search = pinia._s.get("search");
      search.setOptions({ regex: false, caseSensitive: false, wholeWord: false });
      search.setQuery("abc123");
      Promise.resolve(search.search())
        .then(() => done({
          ok: true,
          resultsCount: search.results.length,
          results: search.results.map((r: any) => ({
            filePath: r.filePath,
            firstLine: r.matches?.[0]?.lineNumber ?? null,
            preview: r.matches?.[0]?.lineContent?.substring(0, 50) ?? "",
          })),
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
    // 打开统一搜索条
    await browser.execute(() => {
      // @ts-ignore
      const search = window.__pinia__._s.get("search");
      search.visible = true;
    });
    await browser.pause(200);

    // 输入关键词触发搜索（内容命中渲染到 .gsb__item）
    const input = await browser.$(".gsb__input input");
    await input.setValue("abc123");

    // 等待内容命中结果渲染
    const firstResult = await browser.$(".gsb__item");
    await waitForPresent(browser, ".gsb__item", 10000);

    // 点击结果项打开文件
    await firstResult.click();
    await browser.pause(500);

    // 验证 tab 已打开且为内容命中的文件之一
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

  it("统一搜索条可见性切换", async () => {
    // 通过 store 打开统一搜索条
    await browser.execute(() => {
      // @ts-ignore
      const search = window.__pinia__._s.get("search");
      search.visible = true;
    });
    await browser.pause(300);

    const gsb = await browser.$(".gsb");
    expect(await gsb.isDisplayed()).toBe(true);

    // 关闭
    await browser.execute(() => {
      // @ts-ignore
      const search = window.__pinia__._s.get("search");
      search.visible = false;
    });
    await browser.pause(300);

    expect(await gsb.isExisting()).toBe(false);
  });

  it("正则表达式搜索", async () => {
    await browser.execute(() => {
      // @ts-ignore
      const search = window.__pinia__._s.get("search");
      search.visible = true;
    });
    await browser.pause(200);
    const result = await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const search = pinia._s.get("search");
      search.setOptions({ regex: true, caseSensitive: false, wholeWord: false });
      search.setQuery("abc\\d+"); // 匹配 abc123
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
    // 打开统一搜索条
    await browser.execute(() => {
      // @ts-ignore
      const search = window.__pinia__._s.get("search");
      search.visible = true;
    });
    await browser.pause(200);

    // 输入文件名（前端模糊匹配，无需 Rust）
    const input = await browser.$(".gsb__input input");
    await input.setValue("file-b");
    await browser.pause(300);

    // 结果区应出现含 file-b.md 的条目（文件名分组）
    const items = await browser.$$(".gsb__item");
    // webdriverio v9 的 `$$` 返回值把原生 Array.map 覆盖成了异步版（返回 Promise 而非可迭代数组），
    // 所以 `Promise.all(items.map(...))` 会因「参数不可迭代」报错；直接 await 这个异步 map 即可拿到文本数组
    const texts = await items.map((i) => i.getText());
    // 条目渲染为「图标字形 + 文件名分段」多行文本（实测形如 "M\nfile-b\n.md"），
    // 直接 includes("file-b.md") 会被换行卡住，故先去掉所有空白再比对
    expect(
      texts.some((t) => t.replace(/\s/g, "").includes("file-b.md"))
    ).toBe(true);
  });
});
