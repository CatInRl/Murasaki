/**
 * 编辑器预览双向滚动同步 E2E 测试（覆盖 H9）
 *
 * 验证：
 * - H9a: 预览区元素带 data-source-line 属性（同步基础）
 * - H9b: 编辑器滚动 → 预览跟随滚动
 * - H9c: 预览滚动 → 编辑器跟随滚动
 *
 * 通过 dispatch scroll 事件 + 验证 scrollTop 变化。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace, defaultFixtureFiles } from "../helpers/fixtures";
import {
  openWorkspace,
  closeWorkspace,
  closeAllTabs,
  openFileInTab,
  waitForPinia,
  dismissAllDialogs,
  ensureSplitMode,
  resetPersistenceSettings,
} from "../helpers/store";
import { resolve } from "node:path";

let browser: Browser;
let wsPath: string;

describe("编辑器预览双向滚动同步", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
    await ensureSplitMode(browser);
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  beforeEach(async () => {
    await resetPersistenceSettings(browser);
    // 创建长文档以产生可滚动内容
    const longContent = [
      "# 长文档测试",
      "",
      "## 第一节",
      "",
      "这是第一节的内容。" + "测试内容 ".repeat(80),
      "",
      "## 第二节",
      "",
      "这是第二节的内容。" + "测试内容 ".repeat(80),
      "",
      "## 第三节",
      "",
      "这是第三节的内容。" + "测试内容 ".repeat(80),
      "",
      "## 第四节",
      "",
      "这是第四节的内容。" + "测试内容 ".repeat(80),
      "",
      "## 第五节",
      "",
      "这是第五节的内容。" + "测试内容 ".repeat(80),
      "",
    ].join("\n");

    wsPath = resetWorkspace([
      ...defaultFixtureFiles(),
      { path: "long-doc.md", content: longContent },
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
    await ensureSplitMode(browser);
  });

  it("预览区元素带 data-source-line 属性", async () => {
    const mdPath = resolve(wsPath, "long-doc.md").replace(/\\/g, "/");
    await openFileInTab(browser, mdPath);

    const preview = await browser.$(".pane-right .markdown-body, .preview-pane .markdown-body");
    await preview.waitForExist({ timeout: 10000 });

    // 验证预览中有带 data-source-line 的元素
    const lineElements = await browser.execute(() => {
      const container = document.querySelector(".markdown-body");
      if (!container) return { count: 0, samples: [] as number[] };
      const elements = container.querySelectorAll("[data-source-line]");
      const samples: number[] = [];
      for (let i = 0; i < Math.min(elements.length, 5); i++) {
        const line = parseInt(elements[i].getAttribute("data-source-line") || "0", 10);
        samples.push(line);
      }
      return { count: elements.length, samples };
    });

    expect(lineElements.count).toBeGreaterThan(0);
    expect(lineElements.samples.length).toBeGreaterThan(0);
    // 行号应递增
    for (let i = 1; i < lineElements.samples.length; i++) {
      expect(lineElements.samples[i]).toBeGreaterThanOrEqual(lineElements.samples[i - 1]);
    }
  });

  it("编辑器滚动 → 预览跟随滚动", async () => {
    const mdPath = resolve(wsPath, "long-doc.md").replace(/\\/g, "/");
    await openFileInTab(browser, mdPath);

    const preview = await browser.$(".preview-pane");
    await preview.waitForExist({ timeout: 10000 });

    // 记录初始滚动位置
    const initialPreviewScroll = await browser.execute(() => {
      const el = document.querySelector(".preview-pane") as HTMLElement;
      return el ? el.scrollTop : 0;
    });

    // 通过 __editorRef__.scrollToLine 滚动编辑器到文档底部
    // EditorView 未暴露在 window 上，故使用 SourceEditor 暴露的 scrollToLine
    await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      const ref = window.__editorRef__;
      if (!ref) return done("no editor ref");
      try {
        const view = ref.getView?.();
        if (!view) return done("no editor view");
        const lastLine = view.state.doc.lines;
        ref.scrollToLine?.(lastLine);
        done(null);
      } catch (e) {
        done(String(e));
      }
    });

    // 等待 scrollSync 节流（50ms）+ 滚动动画 + 渲染
    await browser.pause(2000);

    // 验证预览 scrollTop 变化
    const finalPreviewScroll = await browser.execute(() => {
      const el = document.querySelector(".preview-pane") as HTMLElement;
      return el ? el.scrollTop : 0;
    });

    expect(finalPreviewScroll).toBeGreaterThan(initialPreviewScroll);
  });

  it("预览滚动 → 编辑器跟随滚动", async () => {
    const mdPath = resolve(wsPath, "long-doc.md").replace(/\\/g, "/");
    await openFileInTab(browser, mdPath);

    // 等待加载
    await browser.pause(500);

    // 记录初始编辑器滚动位置
    const initialEditorScroll = await browser.execute(() => {
      const scroller = document.querySelector(".cm-scroller") as HTMLElement;
      return scroller ? scroller.scrollTop : 0;
    });

    // 滚动预览到底部
    await browser.execute(() => {
      const preview = document.querySelector(".preview-pane") as HTMLElement;
      if (preview) {
        preview.scrollTop = preview.scrollHeight;
        // dispatch scroll 事件以触发 useScrollSync 的 onPreviewScroll
        preview.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
    });

    // 等待节流 + 滚动同步
    await browser.pause(500);

    // 验证编辑器 scrollTop 变化
    const finalEditorScroll = await browser.execute(() => {
      const scroller = document.querySelector(".cm-scroller") as HTMLElement;
      return scroller ? scroller.scrollTop : 0;
    });

    expect(finalEditorScroll).toBeGreaterThan(initialEditorScroll);
  });

  it("滚动同步后不产生循环（scrollTop 稳定）", async () => {
    const mdPath = resolve(wsPath, "long-doc.md").replace(/\\/g, "/");
    await openFileInTab(browser, mdPath);
    await browser.pause(500);

    // 滚动编辑器
    await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      const view = window.__editorRef__?.getView?.();
      if (!view) return done("no editor view");
      try {
        const midLine = Math.floor(view.state.doc.lines / 2);
        const midPos = view.state.doc.line(midLine).from;
        view.dispatch({
          effects: (window as any).EditorView?.scrollIntoView?.(midPos, { y: "start" })
            ?? view.state.scrollIntoView(midPos),
        });
        done(null);
      } catch (e) {
        done(String(e));
      }
    });

    // 等待同步 + 节流
    await browser.pause(800);

    // 取两次采样，间隔 300ms，scrollTop 应稳定（不循环）
    const scroll1 = await browser.execute(() => {
      const preview = document.querySelector(".preview-pane") as HTMLElement;
      return preview ? preview.scrollTop : 0;
    });
    await browser.pause(300);
    const scroll2 = await browser.execute(() => {
      const preview = document.querySelector(".preview-pane") as HTMLElement;
      return preview ? preview.scrollTop : 0;
    });

    // 容忍 1px 的浮点误差
    expect(Math.abs(scroll2 - scroll1)).toBeLessThanOrEqual(1);
  });
});
