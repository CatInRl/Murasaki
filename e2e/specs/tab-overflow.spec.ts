/**
 * 全部标签面板 E2E 测试（issue #168 / #280）
 *
 * 覆盖：
 * - 入口常驻 + 计数徽标；面板列出**全部**标签（不受全局搜索条 5 条上限影响）
 * - 按「标题 + 所在目录」过滤；无命中显示空态
 * - 点击项定位并关面板；激活项高亮
 * - Esc 关闭并把焦点还给入口按钮；`↓` 进列表 + `Enter` 定位；点击面板外部关闭
 * - 关闭 dirty 标签弹确认框时面板保持打开
 *
 * 注意（AGENTS.md「e2e 的六个坑」）：等元素一律用 `helpers/wait.ts` 的手写轮询，
 * **不要用元素等待命令**（在本栈下不重试）；浮层判「存在」用 `waitForPresent`
 * （动画期 `opacity: 0` 会被 `waitForRendered` 判为「未渲染」）。
 * `createSession` 已内含 `waitForPinia` 就绪等待，无需重复。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace } from "../helpers/fixtures";
import type { FixtureFile } from "../helpers/fixtures";
import {
  openWorkspace,
  closeWorkspace,
  closeAllTabs,
  openFileInTab,
  getTabsState,
  setActiveContent,
  waitForPinia,
  resetPersistenceSettings,
  dismissAllDialogs,
} from "../helpers/store";
import { waitForPresent, waitForAbsent, waitForInBrowser } from "../helpers/wait";

let browser: Browser;
/** 每次 beforeEach 重建的工作区根目录 */
let wsPath: string;

const BTN = '[data-testid="all-tabs-btn"]';
const PANEL = '[data-testid="all-tabs-panel"]';

/** 7 个文件（跨 3 个目录，含子目录），足以越过全局搜索条的 5 条上限 */
const FIXTURE_FILES: FixtureFile[] = [
  { path: "intro.md", content: "# 简介\n\n正文。\n" },
  { path: "notes.md", content: "# 笔记\n\n正文。\n" },
  { path: "docs/api.md", content: "# API\n\n正文。\n" },
  { path: "docs/guide.md", content: "# 指南\n\n正文。\n" },
  { path: "drafts/one.md", content: "# 草稿一\n" },
  { path: "drafts/two.md", content: "# 草稿二\n" },
  { path: "drafts/three.md", content: "# 草稿三\n" },
];

/** 按相对路径打开若干文件（最后一个成为激活项）；`expectedTotal` 用于分两批打开的场景 */
async function openFiles(relPaths: string[], expectedTotal = relPaths.length): Promise<void> {
  for (const rel of relPaths) {
    await openFileInTab(browser, `${wsPath}/${rel}`);
  }
  await waitForInBrowser(
    browser,
    (expected: number) => {
      // @ts-ignore
      return window.__pinia__._s.get("tabs").tabs.length === expected;
    },
    [expectedTotal],
    { timeout: 15000, message: `打开 ${relPaths.length} 个标签` }
  );
}

/** 打开「全部标签」面板（若已打开则不再点击，避免把面板切回去） */
async function openPanel(): Promise<void> {
  await waitForPresent(browser, BTN, 10000);
  if (await browser.$(PANEL).isExisting()) return;
  await (await browser.$(BTN)).click();
  await waitForPresent(browser, PANEL, 8000);
}

async function focusSearch(): Promise<void> {
  await browser.execute((sel: string) => {
    const input = document.querySelector(`${sel} .all-tabs-search`) as HTMLInputElement | null;
    input?.focus();
  }, PANEL);
}

/** 收尾：面板展开态由 App.vue 持有（会话级），逐个用例关掉，避免污染下一条 */
async function closePanelIfOpen(): Promise<void> {
  if (!(await browser.$(PANEL).isExisting())) return;
  await focusSearch();
  await browser.keys(["Escape"]);
  await waitForAbsent(browser, PANEL, 8000);
}

/** 读面板中的条目标题（顺序即标签栏顺序） */
async function panelTitles(): Promise<string[]> {
  return await browser.execute((sel: string) =>
    Array.from(document.querySelectorAll(`${sel} .all-tabs-item .all-tabs-title`)).map((el) =>
      (el.textContent ?? "").trim()
    ), PANEL);
}

/** 等面板条目数落到期望值 */
async function waitForEntryCount(expected: number, message: string): Promise<void> {
  await waitForInBrowser(
    browser,
    (sel: string, want: number) =>
      document.querySelectorAll(`${sel} .all-tabs-item`).length === want,
    [PANEL, expected],
    { timeout: 8000, message }
  );
}

/** 在面板中点击标题为 `title` 的条目（原生 click，Vue 监听器照常触发） */
async function clickEntry(title: string): Promise<void> {
  const ok = await browser.execute(
    (sel: string, name: string) => {
      const items = Array.from(document.querySelectorAll(`${sel} .all-tabs-item`));
      const target = items.find(
        (el) => (el.querySelector(".all-tabs-title")?.textContent ?? "").trim() === name
      ) as HTMLElement | undefined;
      if (!target) return false;
      target.click();
      return true;
    },
    PANEL,
    title
  );
  if (!ok) throw new Error(`面板中未找到标题为「${title}」的条目`);
}

/** 点击标题为 `title` 的条目上的单项关闭按钮 */
async function clickEntryClose(title: string): Promise<void> {
  const ok = await browser.execute(
    (sel: string, name: string) => {
      const items = Array.from(document.querySelectorAll(`${sel} .all-tabs-item`));
      const target = items.find(
        (el) => (el.querySelector(".all-tabs-title")?.textContent ?? "").trim() === name
      );
      const btn = target?.querySelector(".all-tabs-close") as HTMLElement | null | undefined;
      if (!btn) return false;
      btn.click();
      return true;
    },
    PANEL,
    title
  );
  if (!ok) throw new Error(`面板中未找到标题为「${title}」的条目的关闭按钮`);
}

/** 搜索框输入过滤词 */
async function typeSearch(text: string): Promise<void> {
  const input = await browser.$(`${PANEL} .all-tabs-search`);
  await input.clearValue();
  await input.setValue(text);
}

/** 等激活标签的路径以 `suffix` 结尾 */
async function waitForActivePathEndingWith(suffix: string, message: string): Promise<void> {
  await waitForInBrowser(
    browser,
    (want: string) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      const active = tabs.tabs.find((t: { id: string }) => t.id === tabs.activeTabId);
      return !!active && String(active.path ?? "").endsWith(want);
    },
    [suffix],
    { timeout: 8000, message }
  );
}

describe("全部标签面板", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  beforeEach(async () => {
    wsPath = resetWorkspace(FIXTURE_FILES);
    await resetPersistenceSettings(browser);
    try {
      await closeWorkspace(browser);
    } catch {
      // ignore
    }
    await closeAllTabs(browser);
    await dismissAllDialogs(browser);
    await openWorkspace(browser, wsPath);
    await waitForPresent(browser, ".file-tree", 10000);
  });

  afterEach(async () => {
    await closePanelIfOpen();
  });

  it("入口常驻并显示标签总数，面板列出全部标签（不受全局搜索条 5 条上限影响）", async () => {
    await openFiles(FIXTURE_FILES.map((f) => f.path));

    const state = await getTabsState(browser);
    expect(state.tabs.length).toBe(7);

    // 计数徽标 = 标签总数
    await waitForPresent(browser, BTN, 8000);
    const badge = await browser.$(`${BTN} .all-tabs-count`);
    expect((await badge.getText()).trim()).toBe(String(state.tabs.length));

    await openPanel();
    await waitForEntryCount(7, "面板列出全部 7 个标签");

    // 顺序 = 标签栏顺序（store 中的 tabs 顺序）
    expect(await panelTitles()).toEqual(state.tabs.map((t) => t.title));

    // 激活项高亮
    const activeTitle = await browser.execute(
      (sel: string) =>
        (document.querySelector(`${sel} .all-tabs-item.active .all-tabs-title`)?.textContent ?? "").trim(),
      PANEL
    );
    const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
    expect(activeTitle).toBe(activeTab?.title ?? "");
  });

  it("搜索按标题与所在目录过滤；无命中显示空态", async () => {
    await openFiles(["intro.md", "notes.md", "docs/api.md", "docs/guide.md"]);
    await openPanel();
    await waitForEntryCount(4, "面板列出 4 个标签");

    // 标题命中
    await typeSearch("api");
    await waitForEntryCount(1, "标题命中 api.md");
    expect(await panelTitles()).toEqual(["api.md"]);

    // 所在目录命中（标题不含关键词时的主要定位手段）
    await typeSearch("docs");
    await waitForEntryCount(2, "目录命中 docs 下的两个文件");
    expect((await panelTitles()).sort()).toEqual(["api.md", "guide.md"]);

    // 无命中 → 空态
    await typeSearch("zzz");
    await waitForEntryCount(0, "无命中时列表为空");
    await waitForPresent(browser, `${PANEL} .all-tabs-empty`, 5000);
  });

  it("点击列表项定位到该标签并关闭面板", async () => {
    await openFiles(["intro.md", "notes.md"]);

    await openPanel();
    await waitForEntryCount(2, "面板列出 2 个标签");

    await clickEntry("intro.md");

    await waitForActivePathEndingWith("intro.md", "已切换到 intro.md");
    await waitForAbsent(browser, PANEL, 8000);
  });

  it("Esc 关闭面板并把焦点还给入口按钮", async () => {
    await openFiles(["intro.md", "notes.md"]);

    await openPanel();

    // 打开时焦点落在搜索框（过滤几乎总是第一步）
    const focusInBrowser = (sel: string): Promise<boolean> =>
      browser.execute((s: string) => {
        const el = document.querySelector(s);
        return !!el && document.activeElement === el;
      }, sel);

    await waitForInBrowser(
      browser,
      (sel: string) => {
        const el = document.querySelector(`${sel} .all-tabs-search`);
        return !!el && document.activeElement === el;
      },
      [PANEL],
      { timeout: 5000, message: "打开面板后焦点在搜索框" }
    );
    expect(await focusInBrowser(`${PANEL} .all-tabs-search`)).toBe(true);

    await browser.keys(["Escape"]);
    await waitForAbsent(browser, PANEL, 8000);

    // 焦点还给入口按钮，留一条再次打开的路
    await waitForInBrowser(
      browser,
      (sel: string) => document.activeElement === document.querySelector(sel),
      [BTN],
      { timeout: 5000, message: "Esc 后焦点回到入口按钮" }
    );
    expect(await focusInBrowser(BTN)).toBe(true);
  });

  it("键盘 ↓ 进入列表，Enter 定位并关面板", async () => {
    await openFiles(["intro.md", "notes.md", "docs/api.md"]);

    await openPanel();
    await waitForEntryCount(3, "面板列出 3 个标签");
    await focusSearch();

    // 两次 ↓ → 高亮第 2 项（notes.md）
    await browser.keys(["ArrowDown"]);
    await browser.keys(["ArrowDown"]);
    await browser.keys(["Enter"]);

    await waitForActivePathEndingWith("notes.md", "↓↓ + Enter 定位到 notes.md");
    await waitForAbsent(browser, PANEL, 8000);
  });

  it("点击面板外部关闭", async () => {
    await openFiles(["intro.md", "notes.md"]);
    await openPanel();

    await waitForPresent(browser, ".cm-content", 8000);
    await (await browser.$(".cm-content")).click();

    await waitForAbsent(browser, PANEL, 8000);
  });

  it("关闭 dirty 标签弹出确认框时，面板保持打开", async () => {
    await openFiles(["intro.md"]);
    await setActiveContent(browser, "# 简介\n\n已修改但未保存。\n");
    await openFiles(["notes.md"], 2);

    await openPanel();
    await waitForEntryCount(2, "面板列出 2 个标签");

    await clickEntryClose("intro.md");

    // 未保存提示（全局确认框 Teleport 到 body，对 NPopover 而言是「外部点击」）
    await waitForPresent(browser, ".dialog-overlay", 8000);
    expect(await browser.$(PANEL).isExisting()).toBe(true);

    // 取消关闭 → 面板仍在（面向「连续整理」）
    const cancelBtn = await browser.$(".dialog-footer .dialog-btn:not(.primary)");
    await cancelBtn.click();
    await waitForAbsent(browser, ".dialog-overlay", 8000);

    expect(await browser.$(PANEL).isExisting()).toBe(true);
    expect((await panelTitles()).length).toBe(2);
  });
});
