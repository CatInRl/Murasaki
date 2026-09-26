/**
 * 文件树键盘导航 E2E 测试（0.9.0 / #190 ARIA tree + 键盘可达）
 *
 * 验证：
 * - 容器 role="tree"，节点行 role="treeitem"，aria-level / aria-selected
 * - roving tabindex：首个可见条目 tabindex=0，其余 -1
 * - ↑/↓ 移动焦点（首尾不循环）、Home/End 跳首尾
 * - → 展开目录或进入子项、← 折叠目录或回父级
 * - Enter/Space 打开文件或切换目录
 * - Shift+F10 在焦点行弹出右键菜单
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
  dismissAllDialogs,
  resetPersistenceSettings,
  getTabsState,
} from "../helpers/store";
import { waitForPresent, waitForRendered } from "../helpers/wait";

let browser: Browser;
let wsPath: string;

/** 在文件树焦点行上派发 keydown（事件冒泡到 role=tree 容器） */
async function pressTreeKey(
  b: Browser,
  key: string,
  opts: { shift?: boolean } = {}
): Promise<void> {
  await b.execute(
    (k: string, s: boolean) => {
      const el =
        (document.activeElement as HTMLElement | null) ??
        (document.querySelector('[role="tree"]') as HTMLElement | null);
      el?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: k,
          bubbles: true,
          cancelable: true,
          shiftKey: s,
        })
      );
    },
    key,
    !!opts.shift
  );
  await b.pause(250);
}

/** 当前焦点行信息 */
async function focusedRow(b: Browser): Promise<{
  ariaLevel: string | null;
  label: string;
} | null> {
  return b.execute(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || !el.classList.contains("node-row")) return null;
    const labelEl = el.querySelector(".node-name");
    return {
      ariaLevel: el.getAttribute("aria-level"),
      label: (labelEl?.textContent ?? el.textContent ?? "").trim(),
    };
  });
}

async function focusFirstRow(b: Browser): Promise<void> {
  const focused = await b.execute(() => {
    const el = document.querySelector(
      '[role="tree"] .node-row'
    ) as HTMLElement | null;
    if (!el) return false;
    el.focus();
    return true;
  });
  // 显式失败：节点没渲染出来时静默跳过会让后续按键全部落空，
  // 错误表象（菜单/焦点不对）离真因很远（#270）
  if (!focused) throw new Error("focusFirstRow: 未找到 .node-row（文件树节点未渲染）");
  await b.pause(200);
}

describe("文件树键盘导航", () => {
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
    wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    // 等「行」渲染出来，而不是只等容器 [role="tree"] —— 容器先挂载、行由异步
    // list_tree 结果渲染，只等容器会让 focusFirstRow() 与后续按键静默落空（#270）
    await waitForRendered(browser, '[role="treeitem"]', 10000);
  });

  it("ARIA tree 结构：容器 role=tree，行 role=treeitem + aria-level", async () => {
    const rows = await browser.$$('[role="treeitem"]');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const level = await row.getAttribute("aria-level");
      expect(Number(level)).toBeGreaterThanOrEqual(1);
    }
  });

  it("roving tabindex：仅首个可见条目 tabindex=0", async () => {
    const tabindexes = await browser.execute(() =>
      Array.from(document.querySelectorAll('[role="treeitem"]')).map((el) =>
        el.getAttribute("tabindex")
      )
    );
    expect(tabindexes.filter((t) => t === "0").length).toBe(1);
    expect(tabindexes[0]).toBe("0");
  });

  it("↓/↑ 移动焦点且首尾不循环", async () => {
    await focusFirstRow(browser);
    const first = await focusedRow(browser);
    expect(first).not.toBeNull();

    await pressTreeKey(browser, "ArrowDown");
    const second = await focusedRow(browser);
    expect(second).not.toBeNull();
    expect(second!.label).not.toBe(first!.label);

    await pressTreeKey(browser, "ArrowUp");
    const back = await focusedRow(browser);
    expect(back!.label).toBe(first!.label);

    // 在首项继续 ↑ 不循环到末尾
    await pressTreeKey(browser, "ArrowUp");
    const stillFirst = await focusedRow(browser);
    expect(stillFirst!.label).toBe(first!.label);
  });

  it("Home / End 跳到首尾", async () => {
    await focusFirstRow(browser);
    await pressTreeKey(browser, "End");
    const last = await focusedRow(browser);
    await pressTreeKey(browser, "Home");
    const first = await focusedRow(browser);
    expect(last).not.toBeNull();
    expect(first).not.toBeNull();
    expect(last!.label).not.toBe(first!.label);
  });

  it("→ 展开目录后进入子项，← 折叠回父级", async () => {
    // 找到目录行（含 node-arrow 图标）
    const dirIndex = await browser.execute(() =>
      Array.from(document.querySelectorAll('[role="treeitem"]')).findIndex((el) =>
        el.querySelector(".node-arrow")
      )
    );
    expect(dirIndex).toBeGreaterThanOrEqual(0);

    await browser.execute((i: number) => {
      const el = document.querySelectorAll('[role="treeitem"]')[i] as HTMLElement;
      el.focus();
    }, dirIndex);
    await browser.pause(200);

    const before = await browser.$$('[role="treeitem"]');
    await pressTreeKey(browser, "ArrowRight"); // 展开
    await browser.pause(300);
    await pressTreeKey(browser, "ArrowRight"); // 进入第一个子项
    const after = await browser.$$('[role="treeitem"]');
    expect(after.length).toBeGreaterThan(before.length);

    const child = await focusedRow(browser);
    expect(child!.ariaLevel).toBe("2");

    await pressTreeKey(browser, "ArrowLeft"); // 回父级
    const parent = await focusedRow(browser);
    expect(parent!.ariaLevel).toBe("1");
  });

  it("Enter 打开文件到 tab", async () => {
    // 把焦点移到第一个文件行
    const fileIndex = await browser.execute(() =>
      Array.from(document.querySelectorAll('[role="treeitem"]')).findIndex(
        (el) => !el.querySelector(".node-arrow")
      )
    );
    expect(fileIndex).toBeGreaterThanOrEqual(0);
    await browser.execute((i: number) => {
      const el = document.querySelectorAll('[role="treeitem"]')[i] as HTMLElement;
      el.focus();
    }, fileIndex);
    await browser.pause(200);

    await pressTreeKey(browser, "Enter");
    await browser.waitUntil(
      async () => (await getTabsState(browser)).tabs.length > 0,
      { timeout: 10000 }
    );
  });

  it("Shift+F10 在焦点行弹出右键菜单", async () => {
    await focusFirstRow(browser);
    await pressTreeKey(browser, "F10", { shift: true });

    const menu = await browser.$(".murasaki-context-menu");
    await waitForPresent(browser, ".murasaki-context-menu", 5000);
    expect(await menu.isDisplayed()).toBe(true);

    // 菜单项应可键盘操作：↓ 移动高亮
    const items = await browser.$$(".murasaki-context-menu-item");
    expect(items.length).toBeGreaterThan(0);

    // 清理
    await browser.execute(() => {
      // @ts-ignore
      window.__pinia__._s.get("contextMenu").hide();
    });
  });
});
