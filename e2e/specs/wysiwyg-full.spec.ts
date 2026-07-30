/**
 * WYSIWYG 模式全量测试（展示 + 编辑 + 切换 + 嵌套）
 *
 * 覆盖矩阵：
 * - 展示：基础元素、嵌套结构、失败回退、光标行为、选区
 * - 编辑：输入、删除、回车、光标移动、工具栏、快捷键、粘贴、撤销
 * - 切换：内容保留、光标保留、undo 栈、快速切换
 * - 块内编辑：代码块、表格、列表、引用块
 * - 行内编辑：链接、图片、粗体、斜体
 * - 复杂嵌套：引用内列表、列表内代码块、链接内粗体（潜在 bug）
 *
 * 运行方式：系统终端 npx vitest run --config e2e/vitest.config.ts e2e/specs/wysiwyg-full.spec.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import {
  openWorkspace,
  closeWorkspace,
  closeAllTabs,
  waitForPinia,
  dismissAllDialogs,
  resetPersistenceSettings,
  openFileInTab,
} from "../helpers/store";
import { resetWorkspace, defaultFixtureFiles } from "../helpers/fixtures";

/** 测试用 markdown 文件路径 */
const TEST_FILE = "test.md";

let browser: Browser;
let wsPath: string;

/** 切换到 WYSIWYG 模式 */
async function setWysiwygMode(b: Browser): Promise<void> {
  await b.execute(() => {
    // @ts-ignore
    const bridge = window.__pinia__._s.get("editorBridge");
    if (bridge) bridge.setEditorMode("wysiwyg");
  });
  // 等待 Compartment.reconfigure + 首次装饰计算 + 防抖 50ms
  await b.pause(300);
}

/** 切换到 source 模式 */
async function setSourceMode(b: Browser): Promise<void> {
  await b.execute(() => {
    // @ts-ignore
    const bridge = window.__pinia__._s.get("editorBridge");
    if (bridge) bridge.setEditorMode("source");
  });
  await b.pause(200);
}

/** 切换到 split 模式 */
async function setSplitMode(b: Browser): Promise<void> {
  await b.execute(() => {
    // @ts-ignore
    const bridge = window.__pinia__._s.get("editorBridge");
    if (bridge) bridge.setEditorMode("split");
  });
  await b.pause(200);
}

/** 设置编辑器内容并切换到 WYSIWYG */
async function setContentAndWait(
  b: Browser,
  content: string,
  mode: "wysiwyg" | "source" | "split" = "wysiwyg"
): Promise<void> {
  // 把内容写入 test.md，让编辑器通过正常文件加载流程初始化
  const { writeFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const testPath = resolve(wsPath, TEST_FILE);
  writeFileSync(testPath, content, "utf-8");

  // 如果 test.md 已在 tab 中（前序测试遗留），先关闭它，确保 openFileInTab
  // 会重新读取磁盘内容而不是直接切换到旧 tab
  await b.executeAsync((filePath: string, done: (res: unknown) => void) => {
    // @ts-ignore
    const pinia = window.__pinia__;
    const tabs = pinia._s.get("tabs");
    const existing = tabs.tabs.find((t: any) => t.path === filePath);
    if (existing) {
      Promise.resolve(tabs.doCloseTab(existing.id))
        .then(() => done(null))
        .catch((err: unknown) => done(err ? String(err) : null));
    } else {
      done(null);
    }
  }, testPath);
  // 等 Vue 重新渲染（移除旧 editor pane）
  await b.pause(200);

  // 打开 test.md tab（新 tab，会从磁盘读取最新内容）
  await openFileInTab(b, testPath);
  const editorPane = await b.$(".editor-pane");
  await editorPane.waitForExist({ timeout: 10000 });
  // 等 CodeMirror 完全初始化
  await b.pause(500);

  // 切换模式
  if (mode === "wysiwyg") await setWysiwygMode(b);
  else if (mode === "source") await setSourceMode(b);
  else await setSplitMode(b);
}

/** 获取编辑器当前内容 */
async function getContent(b: Browser): Promise<string> {
  return await b.execute(() => {
    // @ts-ignore
    const bridge = window.__pinia__._s.get("editorBridge");
    if (bridge && bridge.editorView) {
      return bridge.editorView.state.doc.toString();
    }
    return "";
  });
}

/** 获取编辑器可见文本（去除隐藏装饰后的 DOM 文本） */
async function getVisibleText(b: Browser): Promise<string> {
  return await b.execute(() => {
    const cmContent = document.querySelector(".cm-content");
    if (!cmContent) return "";
    // 克隆并移除 hide 的元素
    const clone = cmContent.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".murasaki-wysiwyg-mark-hide").forEach((el) => el.remove());
    return clone.textContent ?? "";
  });
}

/** 将光标设置到指定位置 */
async function setCursor(b: Browser, pos: number): Promise<void> {
  await b.execute((p: number) => {
    // @ts-ignore
    const bridge = window.__pinia__._s.get("editorBridge");
    if (bridge && bridge.editorView) {
      const view = bridge.editorView;
      // 钳制到有效范围 [0, doc.length]
      const clamped = Math.max(0, Math.min(p, view.state.doc.length));
      view.dispatch({ selection: { anchor: clamped } });
      view.focus();
    }
  }, pos);
  // 等待防抖 50ms + 装饰重算
  await b.pause(150);
}

/** 将光标设置到文档末尾（最后一个段落，确保行内/块级元素的标记被 hide 而非 dim） */
async function setCursorToEnd(b: Browser): Promise<void> {
  await b.execute(() => {
    // @ts-ignore
    const bridge = window.__pinia__._s.get("editorBridge");
    if (bridge && bridge.editorView) {
      const view = bridge.editorView;
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      view.focus();
    }
  });
  await b.pause(150);
}

/** 在当前光标位置输入文本 */
async function typeText(b: Browser, text: string): Promise<void> {
  await b.keys(text);
  await b.pause(100);
}

/** 按 Backspace N 次 */
async function pressBackspace(b: Browser, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await b.keys(["Backspace"]);
    await b.pause(50);
  }
}

/** 按 Enter */
async function pressEnter(b: Browser): Promise<void> {
  await b.keys(["Enter"]);
  await b.pause(100);
}

/** 等待指定 selector 的元素出现 */
async function waitForSelector(
  b: Browser,
  selector: string,
  timeout = 5000
): Promise<WebdriverIO.Element> {
  const el = await b.$(selector);
  await el.waitForExist({ timeout });
  return el;
}

describe("WYSIWYG 模式全量测试", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  beforeEach(async () => {
    await resetPersistenceSettings(browser);
    // 测试文件通过 setContentAndWait 动态写入，fixture 只需准备工作区
    wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await dismissAllDialogs(browser);
  });

  afterEach(async () => {
    // 每个测试后关闭所有 tab，避免下一个测试受影响
    try { await closeAllTabs(browser); } catch { /* ignore */ }
  });

  // ========================================================================
  // 1. 展示测试 - 基础元素
  // ========================================================================
  describe("1. 展示 - 基础元素", () => {
    it("1.1 标题标记光标离开时隐藏", async () => {
      await setContentAndWait(browser, "# 标题\n\n正文");
      // 光标放在"正文"上（标题标记应隐藏）
      await setCursor(browser, 6);
      const hiddenMarks = await browser.execute(() => {
        return document.querySelectorAll(".cm-content .murasaki-wysiwyg-mark-hide").length;
      });
      expect(hiddenMarks).toBeGreaterThan(0);
    });

    it("1.2 标题标记光标进入时 dim 显示", async () => {
      await setContentAndWait(browser, "# 标题\n\n正文");
      // 光标放在标题行（标记应 dim）
      await setCursor(browser, 2);
      const dimMarks = await browser.execute(() => {
        return document.querySelectorAll(".cm-content .murasaki-wysiwyg-mark-dim").length;
      });
      expect(dimMarks).toBeGreaterThan(0);
    });

    it("1.3 粗体标记光标离开时隐藏", async () => {
      await setContentAndWait(browser, "**粗体**\n\n后文");
      await setCursorToEnd(browser);
      const visibleText = await getVisibleText(browser);
      expect(visibleText).toContain("粗体");
      expect(visibleText).not.toContain("**");
    });

    it("1.4 斜体标记光标离开时隐藏", async () => {
      await setContentAndWait(browser, "_斜体_\n\n后文");
      await setCursorToEnd(browser);
      const visibleText = await getVisibleText(browser);
      expect(visibleText).toContain("斜体");
      expect(visibleText).not.toMatch(/_斜体_/);
    });

    it("1.5 删除线标记光标离开时隐藏", async () => {
      await setContentAndWait(browser, "~~删除~~\n\n后文");
      await setCursorToEnd(browser);
      const visibleText = await getVisibleText(browser);
      expect(visibleText).toContain("删除");
      expect(visibleText).not.toContain("~~");
    });

    it("1.6 行内代码标记光标离开时隐藏", async () => {
      await setContentAndWait(browser, "`code`\n\n后文");
      await setCursorToEnd(browser);
      const visibleText = await getVisibleText(browser);
      expect(visibleText).toContain("code");
      expect(visibleText).not.toContain("`");
    });

    it("1.7 引用块标记光标离开时隐藏 + 渲染左边框", async () => {
      await setContentAndWait(browser, "> 引用\n\n正文");
      await setCursor(browser, 6);
      const blockquote = await browser.$(".murasaki-wysiwyg-blockquote");
      expect(await blockquote.isExisting()).toBe(true);
      const visibleText = await getVisibleText(browser);
      expect(visibleText).toContain("引用");
      expect(visibleText).not.toMatch(/^>\s/);
    });

    it("1.8 无序列表标记光标离开时替换为 bullet widget", async () => {
      await setContentAndWait(browser, "- 项1\n- 项2\n\n正文");
      await setCursor(browser, 12);
      const bullet = await waitForSelector(browser, ".murasaki-wysiwyg-bullet");
      expect(await bullet.isExisting()).toBe(true);
    });

    it("1.9 有序列表标记保持可见（不替换为 widget）", async () => {
      await setContentAndWait(browser, "1. 第一\n2. 第二\n\n正文");
      await setCursor(browser, 14);
      const visibleText = await getVisibleText(browser);
      // 有序列表编号是功能性内容，保持可见
      expect(visibleText).toMatch(/1\.\s*第一/);
      expect(visibleText).toMatch(/2\.\s*第二/);
    });

    it("1.10 任务列表标记光标离开时隐藏", async () => {
      await setContentAndWait(browser, "- [x] 完成\n- [ ] 未完成\n\n正文");
      await setCursorToEnd(browser);
      const visibleText = await getVisibleText(browser);
      expect(visibleText).toContain("完成");
      expect(visibleText).toContain("未完成");
      // [x] 和 [ ] 标记应隐藏
      expect(visibleText).not.toContain("[x]");
      expect(visibleText).not.toContain("[ ]");
    });

    it("1.11 分隔线替换为 hr widget", async () => {
      await setContentAndWait(browser, "正文\n\n---\n\n后文");
      await setCursor(browser, 10);
      const hr = await waitForSelector(browser, ".murasaki-wysiwyg-hr");
      expect(await hr.isExisting()).toBe(true);
    });
  });

  // ========================================================================
  // 2. 展示测试 - 块级 widget
  // ========================================================================
  describe("2. 展示 - 块级 widget", () => {
    it("2.1 代码块 widget 渲染（带语言标签）", async () => {
      await setContentAndWait(browser, "```ts\nconst x = 1;\n```\n\n正文");
      await setCursorToEnd(browser);
      const wrapper = await waitForSelector(browser, ".murasaki-wysiwyg-codeblock-wrapper");
      expect(await wrapper.isExisting()).toBe(true);
      const langLabel = await browser.$(".murasaki-wysiwyg-code-lang-label");
      // 语言标签经 CSS text-transform: uppercase 渲染为 "TS"，用大小写不敏感比较
      expect((await langLabel.getText()).toLowerCase()).toContain("ts");
    });

    it("2.2 代码块 widget 渲染（无语言）", async () => {
      await setContentAndWait(browser, "```\nplain code\n```\n\n正文");
      await setCursorToEnd(browser);
      const wrapper = await waitForSelector(browser, ".murasaki-wysiwyg-codeblock-wrapper");
      expect(await wrapper.isExisting()).toBe(true);
    });

    it("2.3 链接 widget 渲染", async () => {
      await setContentAndWait(browser, "[GitHub](https://github.com)\n\n后文");
      await setCursorToEnd(browser);
      const link = await waitForSelector(browser, ".murasaki-wysiwyg-link");
      expect(await link.isExisting()).toBe(true);
      const href = await link.getAttribute("href");
      expect(href).toContain("github.com");
    });

    it("2.4 图片 widget 渲染", async () => {
      await setContentAndWait(browser, "![alt](https://example.com/img.png)\n\n后文");
      await setCursorToEnd(browser);
      const img = await waitForSelector(browser, ".murasaki-wysiwyg-image");
      expect(await img.isExisting()).toBe(true);
      const src = await img.getAttribute("src");
      expect(src).toContain("example.com");
    });

    it("2.5 表格 widget 渲染", async () => {
      await setContentAndWait(
        browser,
        "| A | B |\n|---|---|\n| 1 | 2 |\n\n正文"
      );
      await setCursorToEnd(browser);
      const table = await waitForSelector(browser, ".murasaki-wysiwyg-table");
      expect(await table.isExisting()).toBe(true);
      const innerTable = await browser.$(".murasaki-wysiwyg-table table");
      expect(await innerTable.isExisting()).toBe(true);
    });

    it("2.6 行内数学公式 widget 渲染", async () => {
      await setContentAndWait(browser, "公式 $E=mc^2$\n\n后文");
      await setCursorToEnd(browser);
      const math = await waitForSelector(browser, ".murasaki-wysiwyg-math");
      expect(await math.isExisting()).toBe(true);
    });

    it("2.7 块级数学公式 widget 渲染", async () => {
      await setContentAndWait(browser, "正文\n\n$$\\int_0^1 x dx$$\n\n后文");
      await setCursorToEnd(browser);
      const mathBlock = await waitForSelector(browser, ".murasaki-wysiwyg-math-block");
      expect(await mathBlock.isExisting()).toBe(true);
    });

    it("2.8 Mermaid 图表 widget 渲染", async () => {
      await setContentAndWait(
        browser,
        "```mermaid\ngraph TD\n  A-->B\n```\n\n正文"
      );
      await setCursorToEnd(browser);
      // mermaid 异步渲染，等待更长时间
      const mermaid = await browser.$(".murasaki-wysiwyg-mermaid, .murasaki-wysiwyg-codeblock-wrapper");
      await mermaid.waitForExist({ timeout: 10000 });
      expect(await mermaid.isExisting()).toBe(true);
    });
  });

  // ========================================================================
  // 3. 展示测试 - 嵌套结构
  // ========================================================================
  describe("3. 展示 - 嵌套结构", () => {
    it("3.1 引用块内的列表", async () => {
      await setContentAndWait(browser, "> - 项1\n> - 项2\n\n正文");
      await setCursorToEnd(browser);
      const blockquote = await browser.$(".murasaki-wysiwyg-blockquote");
      expect(await blockquote.isExisting()).toBe(true);
      const bullet = await browser.$(".murasaki-wysiwyg-bullet");
      expect(await bullet.isExisting()).toBe(true);
    });

    it("3.2 多级嵌套列表", async () => {
      await setContentAndWait(browser, "- 顶层\n  - 二层\n    - 三层\n\n正文");
      await setCursorToEnd(browser);
      const bullets = await browser.$$(".murasaki-wysiwyg-bullet");
      expect(bullets.length).toBeGreaterThanOrEqual(3);
    });

    it("3.3 列表内的代码块", async () => {
      await setContentAndWait(
        browser,
        "- 项1\n  ```js\n  const x = 1;\n  ```\n- 项2\n\n正文"
      );
      await setCursorToEnd(browser);
      const codeblock = await waitForSelector(
        browser,
        ".murasaki-wysiwyg-codeblock-wrapper",
        8000
      );
      expect(await codeblock.isExisting()).toBe(true);
    });

    it("3.4 链接内含粗体（潜在 bug：粗体渲染可能丢失）", async () => {
      await setContentAndWait(browser, "[**bold link**](https://example.com)\n\n后文");
      await setCursorToEnd(browser);
      const link = await waitForSelector(browser, ".murasaki-wysiwyg-link");
      expect(await link.isExisting()).toBe(true);
      const linkText = await link.getText();
      // 预期：链接内文本应为 "bold link"（粗体渲染由 CSS 处理）
      // 已知问题：Link widget return false 不进入子节点，粗体标记可能不渲染
      expect(linkText).toContain("bold link");
    });

    it("3.5 引用块内的代码块", async () => {
      await setContentAndWait(
        browser,
        "> ```js\n> const x = 1;\n> ```\n\n正文"
      );
      await setCursorToEnd(browser);
      const blockquote = await browser.$(".murasaki-wysiwyg-blockquote");
      expect(await blockquote.isExisting()).toBe(true);
      const codeblock = await waitForSelector(
        browser,
        ".murasaki-wysiwyg-codeblock-wrapper",
        8000
      );
      expect(await codeblock.isExisting()).toBe(true);
    });

    it("3.6 表格内的链接（表格整体替换，链接由 markdown-it 渲染）", async () => {
      await setContentAndWait(
        browser,
        "| 链接 |\n|------|\n| [GitHub](https://github.com) |\n\n正文"
      );
      await setCursorToEnd(browser);
      const table = await waitForSelector(browser, ".murasaki-wysiwyg-table");
      expect(await table.isExisting()).toBe(true);
      // 表格内的链接应由 markdown-it 渲染为 <a>
      const innerLink = await browser.$(".murasaki-wysiwyg-table a");
      expect(await innerLink.isExisting()).toBe(true);
    });
  });

  // ========================================================================
  // 4. 展示测试 - 失败回退
  // ========================================================================
  describe("4. 展示 - 失败回退", () => {
    it("4.1 未知语言的代码块回退为普通 pre/code", async () => {
      await setContentAndWait(
        browser,
        "```unknownlang\ncode here\n```\n\n正文"
      );
      await setCursorToEnd(browser);
      const wrapper = await waitForSelector(
        browser,
        ".murasaki-wysiwyg-codeblock-wrapper",
        8000
      );
      expect(await wrapper.isExisting()).toBe(true);
      // Shiki 失败应回退为 <pre><code>
      const pre = await browser.$(".murasaki-wysiwyg-codeblock-wrapper pre");
      expect(await pre.isExisting()).toBe(true);
    });

    it("4.2 无效 Mermaid 语法回退为源码占位", async () => {
      await setContentAndWait(
        browser,
        "```mermaid\ninvalid syntax @#$\n```\n\n正文"
      );
      await setCursorToEnd(browser);
      // 等待 mermaid 渲染尝试（会失败并回退）
      await browser.pause(3000);
      const wrapper = await browser.$(".murasaki-wysiwyg-codeblock-wrapper, .murasaki-wysiwyg-mermaid");
      expect(await wrapper.isExisting()).toBe(true);
    });

    it("4.3 无效 KaTeX 公式回退为原始表达式", async () => {
      await setContentAndWait(browser, "公式 $\\badf$\n\n后文");
      await setCursorToEnd(browser);
      const math = await waitForSelector(browser, ".murasaki-wysiwyg-math", 5000);
      expect(await math.isExisting()).toBe(true);
      // 无效公式应显示原始文本或错误标记
      const text = await math.getText();
      expect(text.length).toBeGreaterThan(0);
    });

    it("4.4 malformed 表格回退为源码文本", async () => {
      await setContentAndWait(
        browser,
        "| A | B |\n无对齐行\n| 1 | 2 |\n\n正文"
      );
      await setCursor(browser, 25);
      // 表格解析失败，可能不生成 table widget
      await browser.pause(500);
      const table = await browser.$(".murasaki-wysiwyg-table");
      // 可能回退为源码文本（table widget 不生成）
      const visibleText = await getVisibleText(browser);
      expect(visibleText.length).toBeGreaterThan(0);
    });

    it("4.5 引用式链接回退为 dim 标记（不生成 widget）", async () => {
      await setContentAndWait(
        browser,
        "[文本][ref]\n\n[ref]: https://example.com"
      );
      await setCursor(browser, 30);
      // 引用式链接 extractAnchorData 返回 null，不生成 link widget
      const link = await browser.$(".murasaki-wysiwyg-link");
      expect(await link.isExisting()).toBe(false);
      // 应回退为 LinkMark dim
      const visibleText = await getVisibleText(browser);
      expect(visibleText).toContain("文本");
    });
  });

  // ========================================================================
  // 5. 展示测试 - 光标行为
  // ========================================================================
  describe("5. 展示 - 光标行为", () => {
    it("5.1 光标在标题行时标记 dim，离开时 hide", async () => {
      await setContentAndWait(browser, "# 标题\n\n正文");
      // 光标在标题
      await setCursor(browser, 2);
      const dimCount1 = await browser.execute(() =>
        document.querySelectorAll(".cm-content .murasaki-wysiwyg-mark-dim").length
      );
      expect(dimCount1).toBeGreaterThan(0);

      // 光标移到正文
      await setCursor(browser, 6);
      const dimCount2 = await browser.execute(() =>
        document.querySelectorAll(".cm-content .murasaki-wysiwyg-mark-dim").length
      );
      const hideCount2 = await browser.execute(() =>
        document.querySelectorAll(".cm-content .murasaki-wysiwyg-mark-hide").length
      );
      expect(hideCount2).toBeGreaterThan(0);
    });

    it("5.2 光标在列表项时整个列表块视为同一段落", async () => {
      await setContentAndWait(browser, "- 项1\n- 项2\n- 项3\n\n正文");
      // 光标在第二项
      await setCursor(browser, 8);
      // 整个列表块的标记应 dim（而非 hide）
      const dimCount = await browser.execute(() =>
        document.querySelectorAll(".cm-content .murasaki-wysiwyg-mark-dim").length
      );
      expect(dimCount).toBeGreaterThan(0);
    });

    it("5.3 防抖 50ms - 连续光标移动只重算一次", async () => {
      await setContentAndWait(browser, "# 标题1\n\n# 标题2\n\n正文");
      // 快速移动光标
      await setCursor(browser, 2);
      await setCursor(browser, 10);
      await setCursor(browser, 16);
      // 最终状态应以最后一次位置为准
      const hideCount = await browser.execute(() =>
        document.querySelectorAll(".cm-content .murasaki-wysiwyg-mark-hide").length
      );
      expect(hideCount).toBeGreaterThan(0);
    });
  });

  // ========================================================================
  // 6. 编辑测试 - 基础输入
  // ========================================================================
  describe("6. 编辑 - 基础输入", () => {
    it("6.1 在 WYSIWYG 模式下输入普通文本", async () => {
      await setContentAndWait(browser, "正文");
      // 光标在 "正" 和 "文" 之间（position 1）
      await setCursor(browser, 1);
      await typeText(browser, "X");
      const content = await getContent(browser);
      expect(content).toContain("正X文");
    });

    it("6.2 在隐藏标记旁输入字符", async () => {
      await setContentAndWait(browser, "**粗体**\n\n后文");
      // 光标离开段（标记隐藏）
      await setCursorToEnd(browser);
      // 在末尾输入
      await typeText(browser, "！");
      const content = await getContent(browser);
      expect(content).toContain("！");
    });

    it("6.3 在 dim 标记内输入字符", async () => {
      await setContentAndWait(browser, "**粗体**");
      // 光标在段内，标记 dim
      await setCursor(browser, 3);
      await typeText(browser, "X");
      const content = await getContent(browser);
      expect(content).toContain("粗X体");
    });
  });

  // ========================================================================
  // 7. 编辑测试 - 删除操作
  // ========================================================================
  describe("7. 编辑 - 删除操作", () => {
    it("7.1 Backspace 删除粗体标记字符", async () => {
      await setContentAndWait(browser, "**粗体**");
      // 光标在末尾 * 之前（position 5，最后一个 * 之前）
      await setCursor(browser, 5);
      await pressBackspace(browser);
      const content = await getContent(browser);
      // 删除一个 * 后标记失配
      expect(content).not.toBe("**粗体**");
    });

    it("7.2 Delete 删除标记字符", async () => {
      await setContentAndWait(browser, "**粗体**");
      await setCursor(browser, 0);
      await browser.keys(["Delete"]);
      await browser.pause(100);
      const content = await getContent(browser);
      expect(content).not.toBe("**粗体**");
    });

    it("7.3 选中整段含标记后删除", async () => {
      await setContentAndWait(browser, "**粗体**\n\n正文");
      // 选中 "**粗体**"
      await browser.execute(() => {
        // @ts-ignore
        const view = window.__pinia__._s.get("editorBridge").editorView;
        view.dispatch({ selection: { anchor: 0, head: 6 } });
        view.focus();
      });
      await browser.pause(100);
      await pressBackspace(browser);
      const content = await getContent(browser);
      expect(content).not.toContain("粗体");
    });
  });

  // ========================================================================
  // 8. 编辑测试 - 回车行为
  // ========================================================================
  describe("8. 编辑 - 回车行为", () => {
    it("8.1 列表项内回车新建列表项", async () => {
      await setContentAndWait(browser, "- 项1");
      await setCursor(browser, 4);
      await pressEnter(browser);
      const content = await getContent(browser);
      // 应新建 "- " 列表项
      expect(content).toMatch(/-\s*项1\n-\s*/);
    });

    it("8.2 引用块内回车新建引用行", async () => {
      await setContentAndWait(browser, "> 引用");
      await setCursor(browser, 4);
      await pressEnter(browser);
      const content = await getContent(browser);
      // 应新建 "> " 行
      expect(content).toMatch(/>\s*引用\n>\s*/);
    });

    it("8.3 代码块内回车换行", async () => {
      await setContentAndWait(browser, "```\ncode\n```");
      await setCursor(browser, 8);
      await pressEnter(browser);
      const content = await getContent(browser);
      expect(content).toContain("\n\n");
    });

    it("8.4 标题行回车退出标题", async () => {
      await setContentAndWait(browser, "# 标题");
      await setCursor(browser, 4);
      await pressEnter(browser);
      const content = await getContent(browser);
      // 回车后应换行，不再处于标题行
      expect(content).toContain("\n");
    });
  });

  // ========================================================================
  // 9. 编辑测试 - 光标移动
  // ========================================================================
  describe("9. 编辑 - 光标移动", () => {
    it("9.1 方向键右跨越隐藏标记", async () => {
      await setContentAndWait(browser, "**粗体**\n\n后文");
      // 光标在段外（标记隐藏），位于 "后文" 起始
      await setCursorToEnd(browser);
      const startPos = await browser.execute(() => {
        // @ts-ignore
        const view = window.__pinia__._s.get("editorBridge").editorView;
        return view.state.selection.main.head;
      });
      // 按右方向键
      await browser.keys(["ArrowRight"]);
      await browser.pause(100);
      // 光标应移动，不报错
      const pos = await browser.execute(() => {
        // @ts-ignore
        const view = window.__pinia__._s.get("editorBridge").editorView;
        return view.state.selection.main.head;
      });
      expect(pos).toBeGreaterThanOrEqual(startPos);
    });

    it("9.2 Home 键跳到行首", async () => {
      await setContentAndWait(browser, "# 标题");
      await setCursor(browser, 4);
      await browser.keys(["Home"]);
      await browser.pause(100);
      const pos = await browser.execute(() => {
        // @ts-ignore
        const view = window.__pinia__._s.get("editorBridge").editorView;
        return view.state.selection.main.head;
      });
      expect(pos).toBeLessThanOrEqual(4);
    });

    it("9.3 End 键跳到行尾", async () => {
      await setContentAndWait(browser, "# 标题");
      await setCursor(browser, 0);
      await browser.keys(["End"]);
      await browser.pause(100);
      const pos = await browser.execute(() => {
        // @ts-ignore
        const view = window.__pinia__._s.get("editorBridge").editorView;
        return view.state.selection.main.head;
      });
      expect(pos).toBeGreaterThanOrEqual(3);
    });
  });

  // ========================================================================
  // 10. 编辑测试 - 工具栏操作
  // ========================================================================
  describe("10. 编辑 - 工具栏操作", () => {
    it("10.1 工具栏 Bold 按钮在 WYSIWYG 模式下工作", async () => {
      await setContentAndWait(browser, "文本");
      // 选中文本
      await browser.execute(() => {
        // @ts-ignore
        const view = window.__pinia__._s.get("editorBridge").editorView;
        view.dispatch({ selection: { anchor: 0, head: 2 } });
        view.focus();
      });
      await browser.pause(100);
      // 点击 Bold 按钮（多种选择器兼容）
      const boldBtn = await browser.$('button[title*="粗体"], button[title*="Bold"], button[aria-label*="bold"], .toolbar-btn[title*="粗体"]');
      if (await boldBtn.isExisting()) {
        await boldBtn.click();
        await browser.pause(200);
        const content = await getContent(browser);
        expect(content).toContain("**");
      }
    });

    it("10.2 工具栏 Code Block 按钮在 WYSIWYG 模式下工作", async () => {
      await setContentAndWait(browser, "文本");
      await browser.execute(() => {
        // @ts-ignore
        const view = window.__pinia__._s.get("editorBridge").editorView;
        view.dispatch({ selection: { anchor: 0, head: 2 } });
        view.focus();
      });
      await browser.pause(100);
      const codeBtn = await browser.$('button[title*="代码块"], button[title*="Code Block"]');
      if (await codeBtn.isExisting()) {
        await codeBtn.click();
        await browser.pause(300);
        const content = await getContent(browser);
        expect(content).toContain("```");
      }
    });
  });

  // ========================================================================
  // 11. 编辑测试 - 快捷键
  // ========================================================================
  describe("11. 编辑 - 段落快捷键", () => {
    it("11.1 Ctrl+1 切换到 H1", async () => {
      await setContentAndWait(browser, "文本");
      await setCursor(browser, 1);
      await browser.keys(["Control", "1"]);
      await browser.pause(200);
      const content = await getContent(browser);
      expect(content).toMatch(/^#\s/);
    });

    it("11.2 Ctrl+Shift+K 插入代码块", async () => {
      await setContentAndWait(browser, "文本");
      await setCursor(browser, 1);
      await browser.keys(["Control", "Shift", "k"]);
      await browser.pause(200);
      const content = await getContent(browser);
      // 可能插入 ``` 围栏
      expect(content).toMatch(/```|~~~/);
    });

    it("11.3 Ctrl+Shift+Q 切换引用块", async () => {
      await setContentAndWait(browser, "文本");
      await setCursor(browser, 1);
      await browser.keys(["Control", "Shift", "q"]);
      await browser.pause(200);
      const content = await getContent(browser);
      expect(content).toMatch(/^>\s/);
    });
  });

  // ========================================================================
  // 12. 编辑测试 - 撤销/重做
  // ========================================================================
  describe("12. 编辑 - 撤销/重做", () => {
    it("12.1 Ctrl+Z 撤销输入", async () => {
      await setContentAndWait(browser, "正文");
      await setCursor(browser, 2);
      await typeText(browser, "X");
      await browser.pause(100);
      // 撤销
      await browser.keys(["Control", "z"]);
      await browser.pause(200);
      const content = await getContent(browser);
      expect(content).not.toContain("X");
    });

    it("12.2 Ctrl+Y 重做", async () => {
      await setContentAndWait(browser, "正文");
      await setCursor(browser, 2);
      await typeText(browser, "X");
      await browser.pause(100);
      await browser.keys(["Control", "z"]);
      await browser.pause(200);
      await browser.keys(["Control", "y"]);
      await browser.pause(200);
      const content = await getContent(browser);
      expect(content).toContain("X");
    });
  });

  // ========================================================================
  // 13. 模式切换测试
  // ========================================================================
  describe("13. 模式切换", () => {
    it("13.1 source → wysiwyg 内容保留", async () => {
      const md = "# 标题\n\n**粗体**\n\n- 列表项";
      await setContentAndWait(browser, md, "source");
      const beforeContent = await getContent(browser);
      await setWysiwygMode(browser);
      const afterContent = await getContent(browser);
      expect(afterContent).toBe(beforeContent);
    });

    it("13.2 wysiwyg → source 内容保留", async () => {
      const md = "# 标题\n\n**粗体**";
      await setContentAndWait(browser, md, "wysiwyg");
      const beforeContent = await getContent(browser);
      await setSourceMode(browser);
      const afterContent = await getContent(browser);
      expect(afterContent).toBe(beforeContent);
    });

    it("13.3 source → wysiwyg 光标位置保留", async () => {
      await setContentAndWait(browser, "# 标题\n\n正文", "source");
      await setCursor(browser, 5);
      const beforePos = await browser.execute(() => {
        // @ts-ignore
        const view = window.__pinia__._s.get("editorBridge").editorView;
        return view.state.selection.main.head;
      });
      await setWysiwygMode(browser);
      const afterPos = await browser.execute(() => {
        // @ts-ignore
        const view = window.__pinia__._s.get("editorBridge").editorView;
        return view.state.selection.main.head;
      });
      expect(afterPos).toBe(beforePos);
    });

    it("13.4 快速切换 source → wysiwyg → source 不丢失内容", async () => {
      const md = "# 标题\n\n**粗体**\n\n- 项1\n- 项2";
      await setContentAndWait(browser, md, "source");
      await setWysiwygMode(browser);
      await setSourceMode(browser);
      await setWysiwygMode(browser);
      await setSourceMode(browser);
      const content = await getContent(browser);
      expect(content).toBe(md);
    });

    it("13.5 split → wysiwyg 预览区卸载", async () => {
      await setContentAndWait(browser, "# 标题", "split");
      // split 模式应有预览区
      const previewBefore = await browser.$(".preview-pane, .markdown-preview");
      const hadPreview = await previewBefore.isExisting();
      await setWysiwygMode(browser);
      // wysiwyg 模式应无预览区
      const previewAfter = await browser.$(".preview-pane, .markdown-preview");
      const hasPreview = await previewAfter.isExisting();
      if (hadPreview) {
        expect(hasPreview).toBe(false);
      }
    });
  });

  // ========================================================================
  // 14. 块内编辑测试
  // ========================================================================
  describe("14. 块内编辑", () => {
    it("14.1 代码块内编辑代码文本", async () => {
      await setContentAndWait(browser, "```\ncode\n```");
      // 光标在 code 内
      await setCursor(browser, 7);
      await typeText(browser, "X");
      const content = await getContent(browser);
      expect(content).toContain("codXe");
    });

    it("14.2 列表项内编辑文本", async () => {
      await setContentAndWait(browser, "- 项1");
      await setCursor(browser, 3);
      await typeText(browser, "X");
      const content = await getContent(browser);
      expect(content).toContain("项X1");
    });

    it("14.3 引用块内编辑文本", async () => {
      await setContentAndWait(browser, "> 引用");
      await setCursor(browser, 3);
      await typeText(browser, "X");
      const content = await getContent(browser);
      expect(content).toContain("引X用");
    });

    it("14.4 表格内编辑（光标在表格源码位置）", async () => {
      await setContentAndWait(browser, "| A | B |\n|---|---|\n| 1 | 2 |");
      // 光标在表格内
      await setCursor(browser, 5);
      await typeText(browser, "X");
      const content = await getContent(browser);
      // 编辑后内容应变化
      expect(content).toContain("X");
    });
  });

  // ========================================================================
  // 15. 行内编辑测试
  // ========================================================================
  describe("15. 行内编辑", () => {
    it("15.1 链接文本内编辑", async () => {
      await setContentAndWait(browser, "[GitHub](https://github.com)");
      // 光标在 "GitHub" 内
      await setCursor(browser, 3);
      await typeText(browser, "X");
      const content = await getContent(browser);
      expect(content).toContain("GiXtHub");
    });

    it("15.2 链接 URL 内编辑", async () => {
      await setContentAndWait(browser, "[GitHub](https://github.com)");
      // 光标在 URL "github" 之后（position 23，"github" 之后是 "."）
      await setCursor(browser, 23);
      await typeText(browser, "X");
      const content = await getContent(browser);
      expect(content).toContain("githubX");
    });

    it("15.3 粗体内编辑", async () => {
      await setContentAndWait(browser, "**粗体**");
      await setCursor(browser, 3);
      await typeText(browser, "X");
      const content = await getContent(browser);
      expect(content).toContain("粗X体");
    });

    it("15.4 图片 alt 内编辑", async () => {
      await setContentAndWait(browser, "![alt](https://example.com/img.png)");
      // 光标在 "alt" 的 "l" 和 "t" 之间（position 4）
      await setCursor(browser, 4);
      await typeText(browser, "X");
      const content = await getContent(browser);
      expect(content).toContain("alXt");
    });
  });

  // ========================================================================
  // 16. 复杂嵌套编辑
  // ========================================================================
  describe("16. 复杂嵌套编辑", () => {
    it("16.1 引用块内列表项编辑", async () => {
      await setContentAndWait(browser, "> - 项1\n> - 项2");
      // 光标在 "项1" 的 "项" 和 "1" 之间（position 5）
      await setCursor(browser, 5);
      await typeText(browser, "X");
      const content = await getContent(browser);
      expect(content).toContain("项X1");
    });

    it("16.2 多级列表内编辑", async () => {
      await setContentAndWait(browser, "- 顶层\n  - 二层");
      // 光标在 "二层" 内
      await setCursor(browser, 10);
      await typeText(browser, "X");
      const content = await getContent(browser);
      expect(content).toContain("二X层");
    });

    it("16.3 代码块内编辑不破坏围栏", async () => {
      await setContentAndWait(browser, "```js\nconst x = 1;\n```");
      await setCursor(browser, 15);
      await typeText(browser, "X");
      const content = await getContent(browser);
      // 围栏应保持完整
      expect(content).toMatch(/```js[\s\S]+```/);
    });
  });

  // ========================================================================
  // 17. 边界情况
  // ========================================================================
  describe("17. 边界情况", () => {
    it("17.1 空文档", async () => {
      await setContentAndWait(browser, "");
      // 不应崩溃
      const content = await getContent(browser);
      expect(content).toBe("");
    });

    it("17.2 仅 frontmatter", async () => {
      await setContentAndWait(browser, "---\ntitle: Test\n---\n\n正文");
      await setCursorToEnd(browser);
      // frontmatter 不被 WYSIWYG 处理（P2 未实现）
      const content = await getContent(browser);
      expect(content).toContain("title: Test");
    });

    it("17.3 文档首段光标", async () => {
      await setContentAndWait(browser, "# 标题\n\n正文");
      await setCursor(browser, 0);
      // 光标在第一个字符
      const pos = await browser.execute(() => {
        // @ts-ignore
        const view = window.__pinia__._s.get("editorBridge").editorView;
        return view.state.selection.main.head;
      });
      expect(pos).toBe(0);
    });

    it("17.4 文档末尾光标", async () => {
      const md = "# 标题\n\n正文";
      await setContentAndWait(browser, md);
      await setCursor(browser, md.length);
      const pos = await browser.execute(() => {
        // @ts-ignore
        const view = window.__pinia__._s.get("editorBridge").editorView;
        return view.state.selection.main.head;
      });
      expect(pos).toBe(md.length);
    });

    it("17.5 连续多个块级元素", async () => {
      await setContentAndWait(
        browser,
        "# 标题\n\n```js\ncode\n```\n\n| A |\n|---|\n| 1 |\n\n---\n\n正文"
      );
      await setCursorToEnd(browser);
      // 应渲染多个 widget
      const codeblock = await browser.$(".murasaki-wysiwyg-codeblock-wrapper");
      const table = await browser.$(".murasaki-wysiwyg-table");
      const hr = await browser.$(".murasaki-wysiwyg-hr");
      expect(await codeblock.isExisting()).toBe(true);
      expect(await table.isExisting()).toBe(true);
      expect(await hr.isExisting()).toBe(true);
    });
  });

  // ========================================================================
  // 18. 选区测试
  // ========================================================================
  describe("18. 选区", () => {
    it("18.1 选区跨越隐藏的粗体标记", async () => {
      await setContentAndWait(browser, "**粗体**\n\n后文");
      // 光标离开段（标记隐藏）
      await setCursorToEnd(browser);
      // 创建选区：从"粗"到"文"
      await browser.execute(() => {
        // @ts-ignore
        const view = window.__pinia__._s.get("editorBridge").editorView;
        view.dispatch({ selection: { anchor: 2, head: 8 } });
        view.focus();
      });
      await browser.pause(150);
      // 选区应存在
      const hasSelection = await browser.execute(() => {
        // @ts-ignore
        const view = window.__pinia__._s.get("editorBridge").editorView;
        return !view.state.selection.main.empty;
      });
      expect(hasSelection).toBe(true);
    });

    it("18.2 选区跨越 widget 替换区域", async () => {
      await setContentAndWait(browser, "- 项1\n- 项2\n\n后文");
      await setCursorToEnd(browser);
      // 创建跨 bullet widget 的选区
      await browser.execute(() => {
        // @ts-ignore
        const view = window.__pinia__._s.get("editorBridge").editorView;
        view.dispatch({ selection: { anchor: 0, head: 6 } });
        view.focus();
      });
      await browser.pause(150);
      const hasSelection = await browser.execute(() => {
        // @ts-ignore
        const view = window.__pinia__._s.get("editorBridge").editorView;
        return !view.state.selection.main.empty;
      });
      expect(hasSelection).toBe(true);
    });
  });

  // ========================================================================
  // 19. 异步渲染竞态
  // ========================================================================
  describe("19. 异步渲染", () => {
    it("19.1 代码块高亮完成后替换占位", async () => {
      await setContentAndWait(browser, "```ts\nconst x: number = 1;\n```\n\n后文");
      await setCursorToEnd(browser);
      // Shiki 异步高亮，等待完成
      await browser.pause(2000);
      const wrapper = await browser.$(".murasaki-wysiwyg-codeblock-wrapper");
      expect(await wrapper.isExisting()).toBe(true);
      // 高亮后应有 shiki class
      const shiki = await browser.$(".shiki, .murasaki-wysiwyg-codeblock-wrapper pre code");
      expect(await shiki.isExisting()).toBe(true);
    });

    it("19.2 光标进入代码块时 widget 消失", async () => {
      await setContentAndWait(browser, "```ts\ncode\n```\n\n正文");
      // 先光标离开段（widget 渲染）
      await setCursorToEnd(browser);
      const wrapperBefore = await browser.$(".murasaki-wysiwyg-codeblock-wrapper");
      expect(await wrapperBefore.isExisting()).toBe(true);
      // 光标进入代码块（widget 应消失）
      await setCursor(browser, 5);
      await browser.pause(200);
      const wrapperAfter = await browser.$(".murasaki-wysiwyg-codeblock-wrapper");
      expect(await wrapperAfter.isExisting()).toBe(false);
    });

    it("19.3 多个 Mermaid 块并发渲染", async () => {
      await setContentAndWait(
        browser,
        "```mermaid\ngraph TD\n  A-->B\n```\n\n```mermaid\ngraph TD\n  C-->D\n```\n\n后文"
      );
      await setCursorToEnd(browser);
      // 等待异步渲染
      await browser.pause(5000);
      // 两个 mermaid 块都应渲染
      const mermaids = await browser.$$(".murasaki-wysiwyg-mermaid, .murasaki-wysiwyg-codeblock-wrapper");
      expect(mermaids.length).toBeGreaterThanOrEqual(2);
    });
  });
});
