/**
 * 文件树选中态 & 统一搜索条 E2E 测试（议题簇 4 / Ticket #69, #70）
 *
 * 验证：
 * - 点击文件后 .node-row.is-selected 样式应用
 * - 选中态背景色为 primary/10 (rgba(147, 51, 234, 0.1))
 * - 内容命中高亮颜色为紫色 (rgba(147, 51, 234, 0.2))
 * - 搜索结果渲染 gsb-hl <mark> 元素
 * - 文件名匹配（前端模糊匹配）渲染
 *
 * 通过 Pinia store 操作 workspace/search，验证统一搜索条（.gsb）UI 渲染。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace, defaultFixtureFiles } from "../helpers/fixtures";
import { openWorkspace, closeWorkspace, openFileInTab, closeAllTabs, waitForPinia, resetPersistenceSettings } from "../helpers/store";

let browser: Browser;

describe("文件树选中态 & 搜索高亮", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  beforeEach(async () => {
    await resetPersistenceSettings(browser);
    try { await closeAllTabs(browser); } catch { /* ignore */ }
    try { await closeWorkspace(browser); } catch { /* ignore */ }
  });

  it("点击文件后节点有 is-selected 类", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);

    // 等待文件树渲染
    const nodes = await browser.$$(".file-tree .tree-node .node-row.is-file");
    expect(nodes.length).toBeGreaterThan(0);

    // 点击第一个文件节点
    await nodes[0].click();
    await browser.pause(300);

    // 验证 is-selected 类存在
    const selected = await browser.$(".node-row.is-selected");
    expect(await selected.isExisting()).toBe(true);
  });

  it("选中态背景色为 primary/10", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);

    const nodes = await browser.$$(".file-tree .tree-node .node-row.is-file");
    await nodes[0].click();
    await browser.pause(300);

    // 检查选中节点的背景色
    const bg = await browser.execute(() => {
      const el = document.querySelector(".node-row.is-selected") as HTMLElement | null;
      if (!el) return "NOT_FOUND";
      return window.getComputedStyle(el).backgroundColor;
    });
    // rgba(147, 51, 234, 0.1) — 浏览器可能解析为 rgba(147, 51, 234, 0.1)
    expect(bg).toContain("147");
    expect(bg).toContain("51");
    expect(bg).toContain("234");
  });

  it("搜索高亮颜色为紫色", async () => {
    const wsPath = resetWorkspace([
      { path: "search-test.md", content: "# Test Document\n\nThis contains keyword in content.\n" },
      { path: "other.md", content: "# Other\n\nNo match here.\n" },
    ]);
    await openWorkspace(browser, wsPath);
    // 等待文件树扫描完成
    await browser.pause(1000);

    // 诊断：直接调用 Tauri search_workspace 命令
    const diagInvoke = await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const workspace = pinia._s.get("workspace");
      const wsPath = workspace.workspacePath;
      // @ts-ignore
      window.__TAURI_INTERNALS__.invoke("search_workspace", {
        workspace: wsPath,
        query: "keyword",
        options: { regex: false, caseSensitive: false, wholeWord: false },
      }).then(
        (resp: any) => done({ ok: true, resp: JSON.stringify(resp).substring(0, 500) }),
        (err: any) => done({ ok: false, error: String(err) })
      );
    });
    console.log("[diag_invoke] " + JSON.stringify(diagInvoke));

    // 打开统一搜索条（挂载会 clear 旧查询），再通过 store 触发内容搜索
    await browser.execute(() => {
      // @ts-ignore
      const search = window.__pinia__._s.get("search");
      search.visible = true;
    });
    await browser.pause(200);
    const searchResult = await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const search = pinia._s.get("search");
      search.setOptions({ regex: false, caseSensitive: false, wholeWord: false });
      search.setQuery("keyword");
      Promise.resolve(search.search())
        .then((resp: any) => done({ ok: true, results: search.results.length, resp: resp ? JSON.stringify(resp).substring(0, 500) : null }))
        .catch((err: unknown) => done({ ok: false, error: err ? String(err) : null }));
    });
    console.log("[diag_search] " + JSON.stringify(searchResult));

    // 等待搜索结果渲染
    const highlight = await browser.$(".gsb-hl");
    await highlight.waitForExist({ timeout: 10000 });

    // 检查高亮颜色
    const bgColor = await browser.execute(() => {
      const mark = document.querySelector(".gsb-hl") as HTMLElement | null;
      if (!mark) return "NOT_FOUND";
      return window.getComputedStyle(mark).backgroundColor;
    });
    // rgba(147, 51, 234, 0.2)
    expect(bgColor).toContain("147");
    expect(bgColor).toContain("51");
    expect(bgColor).toContain("234");
  });

  it("搜索结果渲染 gsb-hl mark 元素", async () => {
    const wsPath = resetWorkspace([
      { path: "highlight.md", content: "# 文档\n\n包含特殊关键词的内容。\n" },
    ]);
    await openWorkspace(browser, wsPath);

    // 打开统一搜索条，再触发搜索
    await browser.execute(() => {
      // @ts-ignore
      const search = window.__pinia__._s.get("search");
      search.visible = true;
    });
    await browser.pause(200);
    await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const search = pinia._s.get("search");
      search.setQuery("特殊关键词");
      Promise.resolve(search.search())
        .then(() => done(null))
        .catch((err: unknown) => done(err ? String(err) : null));
    });

    const marks = await browser.$$(".gsb-hl");
    expect(marks.length).toBeGreaterThan(0);

    // mark 元素的文字应包含搜索关键词
    const firstMarkText = (await marks[0].getText()).trim();
    expect(firstMarkText).toContain("特殊关键词");
  });

  it("文件名匹配渲染", async () => {
    const wsPath = resetWorkspace([
      { path: "match-filename.md", content: "# 文件名匹配测试\n" },
      { path: "other.md", content: "# 其他\n" },
    ]);
    await openWorkspace(browser, wsPath);

    // 打开统一搜索条，输入文件名（前端模糊匹配）
    await browser.execute(() => {
      // @ts-ignore
      const search = window.__pinia__._s.get("search");
      search.visible = true;
    });
    await browser.pause(200);
    const input = await browser.$(".gsb__input input");
    await input.setValue("match-filename");
    await browser.pause(300);

    // 文件名分组应出现含 match-filename 的条目
    const items = await browser.$$(".gsb__item");
    const texts = await Promise.all(items.map((i) => i.getText()));
    expect(texts.some((t) => t.includes("match-filename"))).toBe(true);
  });

  it("统一搜索条可见性切换", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);

    // 通过 store 打开统一搜索条
    await browser.execute(() => {
      // @ts-ignore
      const search = window.__pinia__._s.get("search");
      search.visible = true;
    });
    await browser.pause(300);

    const gsb = await browser.$(".gsb");
    expect(await gsb.isDisplayed()).toBe(true);

    // 关闭统一搜索条
    await browser.execute(() => {
      // @ts-ignore
      const search = window.__pinia__._s.get("search");
      search.visible = false;
    });
    await browser.pause(300);

    expect(await gsb.isExisting()).toBe(false);
  });
});
