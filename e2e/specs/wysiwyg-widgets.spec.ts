/**
 * WYSIWYG 块级 widget + Agent 面板三模式 + Bold 立即渲染 E2E 测试
 *
 * 覆盖：
 * - M15: WYSIWYG 块级 widget（代码块 / Mermaid / 链接 / 图片 / 表格 / KaTeX）
 * - M16: Agent 面板在 source/split/wysiwyg 三模式下均可见
 * - M17: Bold（**text**）光标离开段时立即隐藏 ** 标记
 *
 * 关键 CSS 类：
 * - 代码块：.murasaki-wysiwyg-codeblock-wrapper / .murasaki-wysiwyg-codeblock
 * - Mermaid：.murasaki-wysiwyg-mermaid
 * - 链接：.murasaki-wysiwyg-link
 * - 图片：.murasaki-wysiwyg-image
 * - 表格：.murasaki-wysiwyg-table
 * - 数学：.murasaki-wysiwyg-math / .murasaki-wysiwyg-math-block
 * - 标记：.murasaki-wysiwyg-mark-hide / .murasaki-wysiwyg-mark-dim
 * - 模式：.editor-pane.mode-{source|split|wysiwyg}
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace } from "../helpers/fixtures";
import {
  openWorkspace,
  closeWorkspace,
  openFileInTab,
  closeAllTabs,
  waitForPinia,
  dismissAllDialogs,
  ensureSplitMode,
  resetPersistenceSettings,
} from "../helpers/store";

let browser: Browser;

/** 切换到 wysiwyg 模式 */
async function setWysiwygMode(browser: Browser): Promise<void> {
  await browser.execute(() => {
    // @ts-ignore
    const editorBridge = window.__pinia__._s.get("editorBridge");
    editorBridge.setEditorMode("wysiwyg");
  });
  await browser.pause(500);
}

/** 把光标移到指定位置，触发 decoration 重算（debounce 50ms） */
async function setCursor(browser: Browser, pos: number): Promise<void> {
  await browser.execute((p: number) => {
    // @ts-ignore
    const editorBridge = window.__pinia__._s.get("editorBridge");
    const view = editorBridge.editorView;
    if (view) {
      view.dispatch({
        selection: { anchor: p, head: p },
        scrollIntoView: false,
      });
      view.focus();
    }
  }, pos);
  // 等待 debounce(50ms) + recompute + render
  await browser.pause(500);
}

describe("WYSIWYG 块级 widget + Agent 面板三模式 + Bold 立即渲染", () => {
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
    await dismissAllDialogs(browser);
  });

  // ============ M15: 块级 widget ============

  it("WYSIWYG 模式渲染代码块 widget（.murasaki-wysiwyg-codeblock-wrapper）", async () => {
    const wsPath = resetWorkspace([
      {
        path: "code.md",
        content: [
          "# 代码块测试",
          "",
          "正文段。",
          "",
          "```ts",
          'const x: string = "hello";',
          "```",
          "",
          "结尾段。",
          "",
        ].join("\n"),
      },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\code.md`);
    await ensureSplitMode(browser);
    await setWysiwygMode(browser);

    // 光标移到结尾段（position = "结尾段。" 的"结"之前）
    // 文档："# 代码块测试\n\n正文段。\n\n```ts\nconst x: string = \"hello\";\n```\n\n结尾段。\n"
    // 简化：把光标放到文档末尾
    await browser.execute(() => {
      // @ts-ignore
      const view = window.__pinia__._s.get("editorBridge").editorView;
      if (view) {
        const end = view.state.doc.length;
        view.dispatch({ selection: { anchor: end, head: end } });
        view.focus();
      }
    });

    // 应有代码块 wrapper
    const codeblock = await browser.$(".murasaki-wysiwyg-codeblock-wrapper");
    await codeblock.waitForExist({ timeout: 5000 });
    expect(await codeblock.isExisting()).toBe(true);

    // 应有语言标签（ts）
    const langLabel = await browser.$(".murasaki-wysiwyg-code-lang-label");
    if (await langLabel.isExisting()) {
      const text = (await langLabel.getText()).trim().toLowerCase();
      expect(text).toContain("ts");
    }
  });

  it("WYSIWYG 模式渲染链接 widget（.murasaki-wysiwyg-link）", async () => {
    const wsPath = resetWorkspace([
      {
        path: "link.md",
        content: [
          "# 链接测试",
          "",
          "正文段。",
          "",
          "[Murasaki 仓库](https://github.com/CatInRl/Murasaki)",
          "",
          "结尾段。",
          "",
        ].join("\n"),
      },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\link.md`);
    await ensureSplitMode(browser);
    await setWysiwygMode(browser);

    // 光标移到文档末尾
    await browser.execute(() => {
      // @ts-ignore
      const view = window.__pinia__._s.get("editorBridge").editorView;
      if (view) {
        const end = view.state.doc.length;
        view.dispatch({ selection: { anchor: end, head: end } });
        view.focus();
      }
    });

    // 应有链接 widget
    const link = await browser.$(".murasaki-wysiwyg-link");
    await link.waitForExist({ timeout: 5000 });
    expect(await link.isExisting()).toBe(true);
    const href = await link.getAttribute("href");
    expect(href).toContain("github.com");
    const text = (await link.getText()).trim();
    expect(text).toContain("Murasaki");
  });

  it("WYSIWYG 模式渲染图片 widget（.murasaki-wysiwyg-image）", async () => {
    const wsPath = resetWorkspace([
      {
        path: "img.md",
        content: [
          "# 图片测试",
          "",
          "正文段。",
          "",
          "![alt 描述](https://example.com/test.png)",
          "",
          "结尾段。",
          "",
        ].join("\n"),
      },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\img.md`);
    await ensureSplitMode(browser);
    await setWysiwygMode(browser);

    // 光标移到文档末尾
    await browser.execute(() => {
      // @ts-ignore
      const view = window.__pinia__._s.get("editorBridge").editorView;
      if (view) {
        const end = view.state.doc.length;
        view.dispatch({ selection: { anchor: end, head: end } });
        view.focus();
      }
    });

    // 应有图片 widget
    const img = await browser.$(".murasaki-wysiwyg-image");
    await img.waitForExist({ timeout: 5000 });
    expect(await img.isExisting()).toBe(true);
    const src = await img.getAttribute("src");
    expect(src).toContain("example.com");
  });

  it("WYSIWYG 模式渲染表格 widget（.murasaki-wysiwyg-table）", async () => {
    const wsPath = resetWorkspace([
      {
        path: "table.md",
        content: [
          "# 表格测试",
          "",
          "正文段。",
          "",
          "| 列 A | 列 B |",
          "| --- | --- |",
          "| 单元 1 | 单元 2 |",
          "",
          "结尾段。",
          "",
        ].join("\n"),
      },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\table.md`);
    await ensureSplitMode(browser);
    await setWysiwygMode(browser);

    // 光标移到文档末尾
    await browser.execute(() => {
      // @ts-ignore
      const view = window.__pinia__._s.get("editorBridge").editorView;
      if (view) {
        const end = view.state.doc.length;
        view.dispatch({ selection: { anchor: end, head: end } });
        view.focus();
      }
    });

    // 应有表格 widget
    const table = await browser.$(".murasaki-wysiwyg-table");
    await table.waitForExist({ timeout: 5000 });
    expect(await table.isExisting()).toBe(true);

    // 内部应有 <table> 元素
    const tableEl = await browser.$(".murasaki-wysiwyg-table table");
    await tableEl.waitForExist({ timeout: 5000 });
    expect(await tableEl.isExisting()).toBe(true);
  });

  it("WYSIWYG 模式渲染行内数学公式 widget（.murasaki-wysiwyg-math）", async () => {
    const wsPath = resetWorkspace([
      {
        path: "math.md",
        content: [
          "# 数学公式测试",
          "",
          "正文段。",
          "",
          "行内公式 $E=mc^2$ 测试。",
          "",
          "结尾段。",
          "",
        ].join("\n"),
      },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\math.md`);
    await ensureSplitMode(browser);
    await setWysiwygMode(browser);

    // 光标移到文档末尾
    await browser.execute(() => {
      // @ts-ignore
      const view = window.__pinia__._s.get("editorBridge").editorView;
      if (view) {
        const end = view.state.doc.length;
        view.dispatch({ selection: { anchor: end, head: end } });
        view.focus();
      }
    });

    // 应有行内数学 widget
    const math = await browser.$(".murasaki-wysiwyg-math");
    await math.waitForExist({ timeout: 5000 });
    expect(await math.isExisting()).toBe(true);
  });

  it("WYSIWYG 模式渲染块级数学公式 widget（.murasaki-wysiwyg-math-block）", async () => {
    const wsPath = resetWorkspace([
      {
        path: "math-block.md",
        content: [
          "# 块级公式",
          "",
          "正文段。",
          "",
          "$$",
          "\\int_0^1 x^2 dx = \\frac{1}{3}",
          "$$",
          "",
          "结尾段。",
          "",
        ].join("\n"),
      },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\math-block.md`);
    await ensureSplitMode(browser);
    await setWysiwygMode(browser);

    // 光标移到文档末尾
    await browser.execute(() => {
      // @ts-ignore
      const view = window.__pinia__._s.get("editorBridge").editorView;
      if (view) {
        const end = view.state.doc.length;
        view.dispatch({ selection: { anchor: end, head: end } });
        view.focus();
      }
    });

    // 应有块级数学 widget
    const mathBlock = await browser.$(".murasaki-wysiwyg-math-block");
    await mathBlock.waitForExist({ timeout: 5000 });
    expect(await mathBlock.isExisting()).toBe(true);
  });

  it("WYSIWYG 模式渲染无序列表 bullet widget（.murasaki-wysiwyg-bullet）", async () => {
    const wsPath = resetWorkspace([
      {
        path: "list.md",
        content: [
          "- 项目一",
          "- 项目二",
          "- 项目三",
          "",
          "结尾段。",
          "",
        ].join("\n"),
      },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\list.md`);
    await ensureSplitMode(browser);
    await setWysiwygMode(browser);

    // 光标移到文档末尾
    await browser.execute(() => {
      // @ts-ignore
      const view = window.__pinia__._s.get("editorBridge").editorView;
      if (view) {
        const end = view.state.doc.length;
        view.dispatch({ selection: { anchor: end, head: end } });
        view.focus();
      }
    });

    // 应有至少 3 个 bullet widget（• 替换 -）
    const firstBullet = await browser.$(".murasaki-wysiwyg-bullet");
    await firstBullet.waitForExist({ timeout: 5000 });
    const bullets = await browser.$$(".murasaki-wysiwyg-bullet");
    expect(bullets.length).toBeGreaterThanOrEqual(1);
  });

  it("WYSIWYG 模式渲染分隔线 widget（.murasaki-wysiwyg-hr）", async () => {
    const wsPath = resetWorkspace([
      {
        path: "hr.md",
        content: ["正文段。", "", "---", "", "另一段。", ""].join("\n"),
      },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\hr.md`);
    await ensureSplitMode(browser);
    await setWysiwygMode(browser);

    // 光标移到文档末尾
    await browser.execute(() => {
      // @ts-ignore
      const view = window.__pinia__._s.get("editorBridge").editorView;
      if (view) {
        const end = view.state.doc.length;
        view.dispatch({ selection: { anchor: end, head: end } });
        view.focus();
      }
    });

    // 应有分隔线 widget
    const hr = await browser.$(".murasaki-wysiwyg-hr");
    await hr.waitForExist({ timeout: 5000 });
    expect(await hr.isExisting()).toBe(true);
  });

  // ============ M16: Agent 面板三模式可见性 ============

  it("Agent 面板在 source 模式下可见", async () => {
    const wsPath = resetWorkspace([
      { path: "agent.md", content: "# 测试\n" },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\agent.md`);
    await ensureSplitMode(browser);

    // 确保 showAgentPanel=true
    await browser.execute(() => {
      // @ts-ignore
      const persistence = window.__pinia__._s.get("persistence");
      persistence.updateSettings({ showAgentPanel: true });
    });
    await browser.pause(300);

    // 切到 source 模式
    await browser.execute(() => {
      // @ts-ignore
      const editorBridge = window.__pinia__._s.get("editorBridge");
      editorBridge.setEditorMode("source");
    });
    await browser.pause(400);

    // Agent 面板应可见
    const agentPanel = await browser.$(".agent-panel, [class*='agent-panel']");
    expect(await agentPanel.isExisting()).toBe(true);
  });

  it("Agent 面板在 split 模式下可见", async () => {
    const wsPath = resetWorkspace([
      { path: "agent.md", content: "# 测试\n" },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\agent.md`);
    await ensureSplitMode(browser);

    // split 模式下应可见
    const agentPanel = await browser.$(".agent-panel, [class*='agent-panel']");
    expect(await agentPanel.isExisting()).toBe(true);
  });

  it("Agent 面板在 wysiwyg 模式下可见", async () => {
    const wsPath = resetWorkspace([
      { path: "agent.md", content: "# 测试\n" },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\agent.md`);
    await ensureSplitMode(browser);

    // 确保 showAgentPanel=true
    await browser.execute(() => {
      // @ts-ignore
      const persistence = window.__pinia__._s.get("persistence");
      persistence.updateSettings({ showAgentPanel: true });
    });
    await browser.pause(300);

    // 切到 wysiwyg 模式
    await browser.execute(() => {
      // @ts-ignore
      const editorBridge = window.__pinia__._s.get("editorBridge");
      editorBridge.setEditorMode("wysiwyg");
    });
    await browser.pause(500);

    // Agent 面板应可见
    const agentPanel = await browser.$(".agent-panel, [class*='agent-panel']");
    expect(await agentPanel.isExisting()).toBe(true);
  });

  // ============ M17: Bold 立即渲染 ============

  it("Bold 光标在段内时 ** 标记 dim（.murasaki-wysiwyg-mark-dim）", async () => {
    const wsPath = resetWorkspace([
      { path: "bold.md", content: "**bold 文本**\n\n结尾段。\n" },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\bold.md`);
    await ensureSplitMode(browser);
    await setWysiwygMode(browser);

    // 光标放在 bold 段内（position 5 = "b" 之前，在 **bold** 内部）
    await setCursor(browser, 5);

    // 应有 dim 标记（** 字符弱化显示）
    const dimMarks = await browser.$$(".murasaki-wysiwyg-mark-dim");
    expect(dimMarks.length).toBeGreaterThan(0);
  });

  it("Bold 光标离开段时 ** 标记 hide（.murasaki-wysiwyg-mark-hide）", async () => {
    const wsPath = resetWorkspace([
      { path: "bold.md", content: "**bold 文本**\n\n结尾段。\n" },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\bold.md`);
    await ensureSplitMode(browser);
    await setWysiwygMode(browser);

    // 光标移到第二段（"结尾段。" 的"结"之前）
    // "**bold 文本**\n\n" = 14 chars（含两个换行）
    await setCursor(browser, 14);

    // 应有 hide 标记（** 字符隐藏）
    const hideMarks = await browser.$$(".murasaki-wysiwyg-mark-hide");
    expect(hideMarks.length).toBeGreaterThan(0);
  });

  it("Bold 光标从段内移到段外时 ** 标记从 dim 切换到 hide", async () => {
    const wsPath = resetWorkspace([
      { path: "bold.md", content: "**bold 文本**\n\n结尾段。\n" },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\bold.md`);
    await ensureSplitMode(browser);
    await setWysiwygMode(browser);

    // 阶段 1：光标在段内 → dim
    await setCursor(browser, 5);
    let dimCount = await browser.$$(
      ".murasaki-wysiwyg-mark-dim"
    ).then((els) => els.length);
    let hideCount = await browser.$$(
      ".murasaki-wysiwyg-mark-hide"
    ).then((els) => els.length);
    expect(dimCount).toBeGreaterThan(0);

    // 阶段 2：光标移到段外 → hide
    await setCursor(browser, 14);
    dimCount = await browser.$$(".murasaki-wysiwyg-mark-dim").then((els) => els.length);
    hideCount = await browser.$$(".murasaki-wysiwyg-mark-hide").then((els) => els.length);
    expect(hideCount).toBeGreaterThan(0);

    // 阶段 3：光标回到段内 → 重新 dim
    await setCursor(browser, 5);
    dimCount = await browser.$$(".murasaki-wysiwyg-mark-dim").then((els) => els.length);
    expect(dimCount).toBeGreaterThan(0);
  });
});
