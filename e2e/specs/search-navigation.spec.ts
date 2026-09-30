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
import { isRendered, textOfElement, waitForPresent } from "../helpers/wait";
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
    // 打开统一搜索条，并等它挂载完成 —— GSB onMounted 会 clear()（清空 query/results），
    // 挂载完成前写入查询会被清掉（WebKit 上脚本推进可能快于渲染进程完成挂载）
    await browser.execute(() => {
      // @ts-ignore
      const search = window.__pinia__._s.get("search");
      search.visible = true;
    });
    await waitForPresent(browser, ".gsb__input input", 10000);

    // 经 store 驱动搜索（与「搜索关键词返回匹配文件结果」用例同款）：setValue → @input →
    // 250ms 防抖这条输入链路在 WebKit 上不确定（Linux 首跑两个输入驱动用例都没产出结果），
    // store 驱动则每轮 CI 都稳定；await 落定后 results 已被权威覆盖、chunk 监听已清理，
    // 列表不再重渲染，点击也就没有「落在被替换节点上」的竞态
    const result = await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const search = pinia._s.get("search");
      search.setOptions({ regex: false, caseSensitive: false, wholeWord: false });
      search.setQuery("abc123");
      Promise.resolve(search.search())
        .then(() => done({ ok: true, resultsCount: search.results.length }))
        .catch((err: unknown) => done({ ok: false, error: err ? String(err) : null }));
    });
    expect(result as any).toMatchObject({ ok: true });
    expect((result as any).resultsCount).toBeGreaterThanOrEqual(2);

    // 等待内容命中结果渲染（等待在先、取句柄在后：browser.$ 对不存在的元素不抛错，
    // 先取句柄会把等待整步做废 —— #320）
    await waitForPresent(browser, ".gsb__item", 10000);

    // 点击结果项打开文件。openFile 是 async 的 IPC 链（read_text_file + get_file_mtime），
    // WebKitWebDriver 上每条命令都更慢，固定 sleep 等不到 tab；按 #273 的有界重派发手法：
    // 点击后短窗轮询 tabs store，未打开则重取句柄再点，共 3 次。
    const attempts = 3;
    let tabsState: { count: number; activePath: string | null } | null = null;
    for (let attempt = 1; attempt <= attempts && !tabsState; attempt++) {
      const item = await browser.$(".gsb__item");
      await item.click();
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        await browser.pause(300);
        const s = await browser.execute(() => {
          // @ts-ignore
          const tabs = window.__pinia__._s.get("tabs");
          return {
            count: tabs.tabs.length as number,
            activePath: (tabs.activeTab?.path ?? null) as string | null,
          };
        });
        if (s.count >= 1 && (s.activePath ?? "").includes("file-a.md")) {
          tabsState = s;
          break;
        }
      }
    }
    // 验证 tab 已打开且为内容命中的文件之一（首个内容命中是 file-a）
    expect(tabsState).not.toBeNull();
    expect(tabsState!.count).toBeGreaterThanOrEqual(1);
    expect(tabsState!.activePath).toContain("file-a.md");
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
    // 存在性用轮询等，几何用 isRendered：isDisplayed() 在本栈下会持久性误判（见 helpers/wait.ts）
    await waitForPresent(browser, ".gsb", 5000);
    expect(await isRendered(browser, ".gsb")).toBe(true);

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
    // 打开统一搜索条并等挂载完成（同点击用例：先等挂载再写 query，避开 onMounted clear()）
    await browser.execute(() => {
      // @ts-ignore
      const search = window.__pinia__._s.get("search");
      search.visible = true;
    });
    await waitForPresent(browser, ".gsb__input input", 10000);

    // 文件名分组是纯前端 computed（filesSource 对 query 模糊匹配，无需 Rust），
    // 经 store 写入 query 即渲染；同样绕开 WebKit 上不确定的 setValue → @input 链路
    await browser.execute(() => {
      // @ts-ignore
      const search = window.__pinia__._s.get("search");
      search.setQuery("file-b");
    });

    // 条目出现用轮询等（waitForPresent），出现后再取句柄读取
    const items = await browser.$$(".gsb__item");
    // webdriverio v9 的 `$$` 返回值把原生 Array.map 覆盖成了异步版（返回 Promise 而非可迭代数组），
    // 所以 `Promise.all(items.map(...))` 会因「参数不可迭代」报错；直接 await 这个异步 map 即可拿到文本数组
    const texts = await items.map((i) => textOfElement(browser, i));
    // 条目渲染为「图标字形 + 文件名分段」多行文本（实测形如 "M\nfile-b\n.md"），
    // 直接 includes("file-b.md") 会被换行卡住，故先去掉所有空白再比对
    expect(
      texts.some((t) => t.replace(/\s/g, "").includes("file-b.md"))
    ).toBe(true);
  });
});
