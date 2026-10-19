/**
 * 文件树选中态 & 统一搜索条 E2E 测试（议题簇 4 / Ticket #69, #70）
 *
 * 验证：
 * - 点击文件后 .node-row.is-selected 样式应用
 * - 选中态底色为半透明主色（--murasaki-primary-soft）
 * - 内容命中高亮底色为半透明主色（--murasaki-primary-soft-hover）
 * - 搜索结果渲染 gsb-hl <mark> 元素
 * - 文件名匹配（前端模糊匹配）渲染
 *
 * 通过 Pinia store 操作 workspace/search，验证统一搜索条（.gsb）UI 渲染。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace, defaultFixtureFiles } from "../helpers/fixtures";
import {
  openWorkspace,
  closeWorkspace,
  closeAllTabs,
  waitForPinia,
  resetPersistenceSettings,
} from "../helpers/store";
import { isRendered, readText, waitForInBrowser, waitForPresent } from "../helpers/wait";

/**
 * 判断某个元素底色是否是「主色的淡冲」——用于选中态 / 搜索高亮的视觉契约。
 *
 * 为什么不用字符串匹配：`--murasaki-primary-soft` 是
 * `color-mix(in srgb, #9333ea α%, transparent)`，而 `getComputedStyle` 的序列化
 * 随 WebView 实现与版本变化。实测见过三种：
 *   - `rgba(147, 51, 234, α)`（历史硬编码）
 *   - `color(srgb 0.576471 0.2 0.917647 / α)`
 *   - `oklab(0.557523 0.135022 -0.213353 / 0.107903)`（当前 WebView2，CI 上就是这个）
 * #444 收尾时只认前两种，CI 连续两次红在这条。
 *
 * 为什么也不用 canvas 精确等值：`color-mix(in srgb, …)` 12% 与 canvas 上
 * 「12% alpha 叠加」在浏览器内部走的换算路径不同，实测相差 6–9/255
 * （`rgb(244,239,252)` vs `rgb(242,230,252)`），逼得太紧就变成在测实现细节。
 *
 * 所以这里断言**视觉契约本身**：把颜色画到白底上读回 sRGB，然后检查
 * 「明显偏紫（蓝 > 绿）+ 足够浅（是与背景可区分的淡色）」。
 * 这不受色彩空间序列化影响，也允许取整误差。
 */
const SELECTION_FILL = "#ffffff";

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
  });

  it("点击文件后节点有 is-selected 类", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);

    // 等待文件树渲染
    const nodes = await browser.$$(".file-tree .tree-node .node-row.is-file");
    expect(nodes.length).toBeGreaterThan(0);

    // 点击第一个文件节点
    await nodes[0].click();
    // 等选中态真的建立：慢 runner 上固定 pause 不够，且 $() 对不存在的元素不抛错，
    // 早取句柄会让等待白做（#320）
    await waitForPresent(browser, ".node-row.is-selected", 10000);

    // 验证 is-selected 类存在
    expect(await isRendered(browser, ".node-row.is-selected")).toBe(true);
  });

  it("选中态背景色为 primary/10", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);

    const nodes = await browser.$$(".file-tree .tree-node .node-row.is-file");
    await nodes[0].click();
    // 慢 runner 上选中态建立可能晚于固定 pause（CI 上连续两次挂在这条）：
    // 等到元素真的出现再读样式，而不是赌 300ms
    await waitForPresent(browser, ".node-row.is-selected", 10000);
    // 点击后鼠标仍悬在该行上：底色是 hover 态（--murasaki-primary-soft-hover，20%），
    // 不是要断言的选中态（--murasaki-primary-soft，12%）。用真实指针移开
    //（:hover 由浏览器维护，合成 mousemove 事件的 DOM 分发清不掉它）。
    await browser
      .action("pointer")
      .move({ x: 0, y: 0 })
      .perform()
      .catch(() => {
        // 某些 driver 不支持 pointer action：退回滚动到左侧空白处
      });
    await browser.pause(120);

    // 颜色判定放在浏览器里做（Node 侧没有 canvas），契约见 SELECTION_FILL 注释
    const tint = await browser.execute((fill: string) => {
      const el = document.querySelector(".node-row.is-selected") as HTMLElement | null;
      if (!el) return { ok: false, reason: "selected node not found" };
      const color = window.getComputedStyle(el).backgroundColor;

      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d");
      if (!ctx) return { ok: false, reason: "no 2d context", color };
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;

      return {
        // 偏紫（蓝通道明显高于绿与红）+ 是浅色（不是实心主色块）。
        // 不卡具体混合比例：选中态（12%）与鼠标悬停态（20%）都是合格的「淡紫」，
        // 而鼠标停在节点上时底色会从 --primary-soft 切到 --primary-soft-hover。
        ok: b > g + 6 && b > r && Math.min(r, g, b) > 180,
        color,
        composed: `rgb(${r}, ${g}, ${b})`,
      };
    }, SELECTION_FILL);
    expect(tint).toMatchObject({ ok: true });
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
      // @ts-ignore: E2E 运行时注入，类型不可静态推导
      const pinia = window.__pinia__;
      const workspace = pinia._s.get("workspace");
      const wsPath = workspace.workspacePath;
      // @ts-ignore: E2E 运行时注入，类型不可静态推导
      window.__TAURI_INTERNALS__
        .invoke("search_workspace", {
          workspace: wsPath,
          query: "keyword",
          options: { regex: false, caseSensitive: false, wholeWord: false },
        })
        .then(
          (resp: any) => done({ ok: true, resp: JSON.stringify(resp).substring(0, 500) }),
          (err: any) => done({ ok: false, error: String(err) })
        );
    });
    console.log("[diag_invoke] " + JSON.stringify(diagInvoke));

    // 打开统一搜索条（挂载会 clear 旧查询），再通过 store 触发内容搜索
    await browser.execute(() => {
      // @ts-ignore: E2E 运行时注入，类型不可静态推导
      const search = window.__pinia__._s.get("search");
      search.visible = true;
    });
    await browser.pause(200);
    const searchResult = await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore: E2E 运行时注入，类型不可静态推导
      const pinia = window.__pinia__;
      const search = pinia._s.get("search");
      search.setOptions({ regex: false, caseSensitive: false, wholeWord: false });
      search.setQuery("keyword");
      Promise.resolve(search.search())
        .then((resp: any) =>
          done({
            ok: true,
            results: search.results.length,
            resp: resp ? JSON.stringify(resp).substring(0, 500) : null,
          })
        )
        .catch((err: unknown) => done({ ok: false, error: err ? String(err) : null }));
    });
    console.log("[diag_search] " + JSON.stringify(searchResult));

    // 等待搜索结果渲染
    await waitForPresent(browser, ".gsb-hl", 10000);

    // 检查高亮颜色（判定方式与选中态一致，理由见 SELECTION_FILL 注释）
    const tint = await browser.execute((fill: string) => {
      const mark = document.querySelector(".gsb-hl") as HTMLElement | null;
      if (!mark) return { ok: false, reason: "highlight not found" };
      const color = window.getComputedStyle(mark).backgroundColor;

      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d");
      if (!ctx) return { ok: false, reason: "no 2d context", color };
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;

      return {
        ok: b > g + 8 && r > g && Math.min(r, g, b) > 200,
        color,
        composed: `rgb(${r}, ${g}, ${b})`,
      };
    }, SELECTION_FILL);
    expect(tint).toMatchObject({ ok: true });
  });

  it("搜索结果渲染 gsb-hl mark 元素", async () => {
    const wsPath = resetWorkspace([
      { path: "highlight.md", content: "# 文档\n\n包含特殊关键词的内容。\n" },
    ]);
    await openWorkspace(browser, wsPath);

    // 打开统一搜索条，再触发搜索
    await browser.execute(() => {
      // @ts-ignore: E2E 运行时注入，类型不可静态推导
      const search = window.__pinia__._s.get("search");
      search.visible = true;
    });
    await browser.pause(200);
    await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore: E2E 运行时注入，类型不可静态推导
      const pinia = window.__pinia__;
      const search = pinia._s.get("search");
      search.setQuery("特殊关键词");
      Promise.resolve(search.search())
        .then(() => done(null))
        .catch((err: unknown) => done(err ? String(err) : null));
    });

    // mark 渲染必须轮询等：CI 上搜索完成与 DOM 渲染之间有延迟，单次读列表
    // 读太早会得 0（与下方「文件名匹配渲染」同根因，#342 Windows e2e 实录）
    await waitForPresent(browser, ".gsb-hl", 10000);

    // mark 元素的文字应包含搜索关键词
    expect(await readText(browser, ".gsb-hl")).toContain("特殊关键词");
  });

  it("文件名匹配渲染", async () => {
    const wsPath = resetWorkspace([
      { path: "match-filename.md", content: "# 文件名匹配测试\n" },
      { path: "other.md", content: "# 其他\n" },
    ]);
    await openWorkspace(browser, wsPath);

    // 打开统一搜索条，输入文件名（前端模糊匹配）
    await browser.execute(() => {
      // @ts-ignore: E2E 运行时注入，类型不可静态推导
      const search = window.__pinia__._s.get("search");
      search.visible = true;
    });
    await browser.pause(200);
    const input = await browser.$(".gsb__input input");
    await input.setValue("match-filename");
    await browser.pause(300);

    // 文件名分组应出现含 match-filename 的条目。等结果必须轮询而非固定
    // pause(300) + 单次读列表：CI 上模糊匹配有防抖且渲染慢，读太早 items 里
    // 还没有目标条目，some() 恒 false（#342 Windows e2e 实录的 flake 根因）
    await waitForInBrowser(
      browser,
      () => {
        const items = Array.from(document.querySelectorAll(".gsb__item"));
        return items.some((i) => (i.textContent ?? "").includes("match-filename"));
      },
      [],
      { message: "文件名匹配结果（.gsb__item 含 match-filename）", timeout: 10000 }
    );
  });

  it("统一搜索条可见性切换", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);

    // 通过 store 打开统一搜索条
    await browser.execute(() => {
      // @ts-ignore: E2E 运行时注入，类型不可静态推导
      const search = window.__pinia__._s.get("search");
      search.visible = true;
    });
    await browser.pause(300);

    const gsb = await browser.$(".gsb");
    // 存在性用轮询等，几何用 isRendered：isDisplayed() 在本栈下会持久性误判（见 helpers/wait.ts）
    await waitForPresent(browser, ".gsb", 5000);
    expect(await isRendered(browser, ".gsb")).toBe(true);

    // 关闭统一搜索条
    await browser.execute(() => {
      // @ts-ignore: E2E 运行时注入，类型不可静态推导
      const search = window.__pinia__._s.get("search");
      search.visible = false;
    });
    await browser.pause(300);

    expect(await gsb.isExisting()).toBe(false);
  });
});
