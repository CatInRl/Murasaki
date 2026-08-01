/**
 * 快捷键补全 E2E 测试（覆盖 M4-M5, M7, M9 + M6/M8/M10/M11）
 *
 * 验证 App.vue onKeyDown 注册的快捷键：
 * - M4: Ctrl+W 关闭当前 tab
 * - M5: Ctrl+Tab / Ctrl+Shift+Tab 切换 tab
 * - M7: Ctrl+R 重新加载文件
 * - M9: Alt+Shift+S 切换状态栏显隐
 * - M6: Ctrl+Shift+E 切换到文件树侧栏
 * - M8: Ctrl+Shift+M 切换到大纲侧栏
 * - M10: Ctrl+Shift+F 打开跨文件搜索面板
 * - M11: F11 全屏切换（弱断言，避免与 OS 冲突）
 *
 * 实现方式：通过 window.dispatchEvent(new KeyboardEvent("keydown", {...}))
 * 直接触发 App.vue 的 keydown 监听器，绕过 webdriverio keys() 在 tauri-driver
 * 下的不稳定行为。
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

let browser: Browser;
/** 当前测试用工作区路径（由 beforeEach 设置，it 块直接复用，避免重复 resetWorkspace） */
let wsPath: string;

/** 通过 dispatchEvent 触发 keydown（App.vue 的 onKeyDown 监听 window） */
async function pressShortcut(
  browser: Browser,
  key: string,
  opts: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}
): Promise<void> {
  await browser.execute((k: string, c: boolean, s: boolean, a: boolean, m: boolean) => {
    const ev = new KeyboardEvent("keydown", {
      key: k,
      bubbles: true,
      cancelable: true,
      ctrlKey: c,
      shiftKey: s,
      altKey: a,
      metaKey: m,
    });
    window.dispatchEvent(ev);
  }, key, !!opts.ctrl, !!opts.shift, !!opts.alt, !!opts.meta);
}

/**
 * 轮询等待 Pinia store 状态满足断言。
 * 替代固定 pause，按需等待 DOM/store 状态变化。
 */
async function waitForStoreState(
  browser: Browser,
  predicate: () => Promise<boolean> | boolean,
  timeout = 5000
): Promise<void> {
  await browser.waitUntil(predicate, { timeout, interval: 100 });
}

describe("快捷键", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  beforeEach(async () => {
    await resetPersistenceSettings(browser);
    // resetPersistenceSettings 只更新 persistence.settings.sidebarView，
    // 不直接更新 App.vue 的 sidebarView ref（前序 spec 可能切到 outline，
    // 导致 .file-tree 不渲染）。通过 __setSidebarView__ 显式重置。
    await browser.execute(() => {
      // @ts-ignore
      (window as any).__setSidebarView__("files");
    });
    wsPath = resetWorkspace(defaultFixtureFiles());
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
    await ensureSplitMode(browser);
    // 最后清除所有残留对话框/toast（前序 spec 可能遗留 dirty tab 对话框遮挡）
    await dismissAllDialogs(browser);
  });

  // ============ M4: Ctrl+W 关闭当前 tab ============

  it("Ctrl+W 关闭当前 tab", async () => {
    // 打开两个 tab
    await openFileInTab(browser, `${wsPath}\\intro.md`);
    await openFileInTab(browser, `${wsPath}\\notes.md`);
    // 等待两个 tab 都已注册
    await waitForStoreState(browser, async () => {
      const count = await browser.execute(() => {
        // @ts-ignore
        const tabs = window.__pinia__._s.get("tabs");
        return tabs.tabs.length;
      });
      return count === 2;
    });

    let state: { count: number; activeId?: string | null; activeTitle?: string } = await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      return { count: tabs.tabs.length, activeId: tabs.activeTabId };
    });
    expect(state.count).toBe(2);

    // Ctrl+W 关闭当前 tab（notes.md）
    await pressShortcut(browser, "w", { ctrl: true });

    // 应剩 1 个 tab（轮询等待，替代固定 pause）
    await waitForStoreState(browser, async () => {
      const count = await browser.execute(() => {
        // @ts-ignore
        const tabs = window.__pinia__._s.get("tabs");
        return tabs.tabs.length;
      });
      return count === 1;
    });

    state = await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      return { count: tabs.tabs.length, activeTitle: tabs.activeTab ? tabs.getTabTitle(tabs.activeTab) : null };
    });
    expect(state.count).toBe(1);
    expect(state.activeTitle).toBe("intro.md");
  });

  // ============ M5: Ctrl+Tab / Ctrl+Shift+Tab 切换 tab ============

  it("Ctrl+Tab 切换到下一个 tab", async () => {
    await openFileInTab(browser, `${wsPath}\\intro.md`);
    await openFileInTab(browser, `${wsPath}\\notes.md`);
    // 等待 notes.md 成为活跃 tab
    await waitForStoreState(browser, async () => {
      const active = await browser.execute(() => {
        // @ts-ignore
        const tabs = window.__pinia__._s.get("tabs");
        return tabs.activeTab ? tabs.getTabTitle(tabs.activeTab) : null;
      });
      return active === "notes.md";
    });

    // 当前活跃应为 notes.md（最后打开的）
    let active = await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      return tabs.activeTab ? tabs.getTabTitle(tabs.activeTab) : null;
    });
    expect(active).toBe("notes.md");

    // Ctrl+Tab 应切换到下一个（循环到 intro.md）
    await pressShortcut(browser, "Tab", { ctrl: true });
    await waitForStoreState(browser, async () => {
      const a = await browser.execute(() => {
        // @ts-ignore
        const tabs = window.__pinia__._s.get("tabs");
        return tabs.activeTab ? tabs.getTabTitle(tabs.activeTab) : null;
      });
      return a === "intro.md";
    });

    active = await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      return tabs.activeTab ? tabs.getTabTitle(tabs.activeTab) : null;
    });
    expect(active).toBe("intro.md");
  });

  it("Ctrl+Shift+Tab 切换到上一个 tab", async () => {
    await openFileInTab(browser, `${wsPath}\\intro.md`);
    await openFileInTab(browser, `${wsPath}\\notes.md`);
    // 等待 notes.md 成为活跃 tab
    await waitForStoreState(browser, async () => {
      const active = await browser.execute(() => {
        // @ts-ignore
        const tabs = window.__pinia__._s.get("tabs");
        return tabs.activeTab ? tabs.getTabTitle(tabs.activeTab) : null;
      });
      return active === "notes.md";
    });

    // 当前活跃为 notes.md
    // Ctrl+Shift+Tab 应切换到上一个（intro.md）
    await pressShortcut(browser, "Tab", { ctrl: true, shift: true });
    await waitForStoreState(browser, async () => {
      const a = await browser.execute(() => {
        // @ts-ignore
        const tabs = window.__pinia__._s.get("tabs");
        return tabs.activeTab ? tabs.getTabTitle(tabs.activeTab) : null;
      });
      return a === "intro.md";
    });

    const active = await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      return tabs.activeTab ? tabs.getTabTitle(tabs.activeTab) : null;
    });
    expect(active).toBe("intro.md");
  });

  // ============ M7: Ctrl+R 重新加载文件 ============

  it("Ctrl+R 重新加载当前文件（覆盖未保存修改）", async () => {
    // 此测试需要自定义 fixture（reload.md），保留 resetWorkspace 调用
    const reloadWsPath = resetWorkspace([
      { path: "reload.md", content: "# 原始内容\n" },
    ]);
    await openWorkspace(browser, reloadWsPath);
    await openFileInTab(browser, `${reloadWsPath}\\reload.md`);
    // 等待 reload.md 打开为活动 tab
    await waitForStoreState(browser, async () => {
      const title = await browser.execute(() => {
        // @ts-ignore
        const tabs = window.__pinia__._s.get("tabs");
        return tabs.activeTab ? tabs.getTabTitle(tabs.activeTab) : null;
      });
      return title === "reload.md";
    });

    // 修改内容（脏态）
    await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      if (tabs.activeTab) {
        tabs.updateContent(tabs.activeTab.id, "# 修改后的内容\n");
      }
    });
    // 等待脏内容生效
    await waitForStoreState(browser, async () => {
      const content = await browser.execute(() => {
        // @ts-ignore
        const tabs = window.__pinia__._s.get("tabs");
        return tabs.activeTab?.content;
      });
      return content.includes("修改后的内容");
    });

    let content = await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      return tabs.activeTab?.content;
    });
    expect(content).toContain("修改后的内容");

    // App.vue reloadCurrentFile 直接调用 tabsStore.reloadFromDisk，不弹确认
    await pressShortcut(browser, "r", { ctrl: true });
    // 等待内容被磁盘内容覆盖
    await waitForStoreState(browser, async () => {
      const c = await browser.execute(() => {
        // @ts-ignore
        const tabs = window.__pinia__._s.get("tabs");
        return tabs.activeTab?.content;
      });
      return c.includes("原始内容") && !c.includes("修改后的内容");
    });

    // 内容应被磁盘内容覆盖
    content = await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      return tabs.activeTab?.content;
    });
    expect(content).toContain("原始内容");
    expect(content).not.toContain("修改后的内容");
  });

  // ============ M9: Alt+Shift+S 切换状态栏显隐 ============

  it("Alt+Shift+S 切换状态栏显隐", async () => {
    // 初始状态栏应可见
    const statusBar = await browser.$(".status-bar, [class*='status-bar']");
    let exists = await statusBar.isExisting();
    expect(exists).toBe(true);

    // Alt+Shift+S 隐藏
    await pressShortcut(browser, "s", { alt: true, shift: true });

    // 状态栏应消失
    await browser.waitUntil(async () => {
      const visible = await browser.execute(() => {
        return !!document.querySelector(".status-bar");
      });
      return !visible;
    }, { timeout: 3000, interval: 100 });

    // 再次按 Alt+Shift+S 显示
    await pressShortcut(browser, "s", { alt: true, shift: true });

    await browser.waitUntil(async () => {
      const visible = await browser.execute(() => {
        return !!document.querySelector(".status-bar");
      });
      return visible;
    }, { timeout: 3000, interval: 100 });
  });

  // ============ M6: Ctrl+Shift+E 切换到文件树侧栏 ============

  it("Ctrl+Shift+E 切换到文件树侧栏", async () => {
    // 先切换到大纲视图（确保起始状态非 files）
    // 直接通过 __setSidebarView__ 设置 ref，避免 DOM 按钮点击不触发
    // Vue 的 @update:active-view 事件
    await browser.execute(() => {
      // @ts-ignore
      (window as any).__setSidebarView__("outline");
    });
    // 等待切换到大纲视图生效（文件树消失）
    await browser.waitUntil(async () => {
      const tree = await browser.$(".file-tree");
      const displayed = await tree.isDisplayed().catch(() => false);
      return !displayed;
    }, { timeout: 3000, interval: 100 });

    // Ctrl+Shift+E 切换回文件树
    await pressShortcut(browser, "e", { ctrl: true, shift: true });
    // 等待文件树重新可见
    await browser.waitUntil(async () => {
      const tree = await browser.$(".file-tree");
      return await tree.isDisplayed().catch(() => false);
    }, { timeout: 3000, interval: 100 });

    // 文件树应可见
    const fileTree = await browser.$(".file-tree");
    expect(await fileTree.isDisplayed()).toBe(true);
  });

  // ============ M8: Ctrl+Shift+M 切换到大纲侧栏 ============

  it("Ctrl+Shift+M 切换到大纲侧栏", async () => {
    // 起始应为文件树视图
    const fileTree = await browser.$(".file-tree");
    expect(await fileTree.isDisplayed()).toBe(true);

    // Ctrl+Shift+M 切换到大纲
    await pressShortcut(browser, "m", { ctrl: true, shift: true });
    // 等待大纲面板出现
    await browser.waitUntil(async () => {
      const outline = await browser.$(".outline-pane, [class*='outline']");
      return await outline.isExisting().catch(() => false);
    }, { timeout: 3000, interval: 100 });

    // 应显示大纲面板（而非文件树）
    const outline = await browser.$(".outline-pane, [class*='outline']");
    expect(await outline.isExisting()).toBe(true);
    // 文件树应隐藏或大纲面板可见
    const fileTreeVisible = await browser.$(".file-tree").isExisting();
    // 切换后文件树应消失或大纲面板成为主视图
    // （Sidebar.vue 通过 activeView prop 控制显示）
  });

  // ============ M10: Ctrl+Shift+F 打开跨文件搜索面板 ============

  it("Ctrl+Shift+F 打开跨文件搜索面板", async () => {
    // 初始搜索面板应不可见
    let searchVisible = await browser.execute(() => {
      // @ts-ignore
      const search = window.__pinia__._s.get("search");
      return search.visible;
    });
    expect(searchVisible).toBe(false);

    // Ctrl+Shift+F
    await pressShortcut(browser, "f", { ctrl: true, shift: true });
    // 等待 search store visible 变为 true
    await waitForStoreState(browser, async () => {
      const visible = await browser.execute(() => {
        // @ts-ignore
        const search = window.__pinia__._s.get("search");
        return search.visible;
      });
      return visible === true;
    });

    searchVisible = await browser.execute(() => {
      // @ts-ignore
      const search = window.__pinia__._s.get("search");
      return search.visible;
    });
    expect(searchVisible).toBe(true);

    // 搜索面板 DOM 应存在
    const searchPanel = await browser.$(".search-panel, [class*='search-panel']");
    expect(await searchPanel.isExisting()).toBe(true);
  });

  // ============ M11: F11 全屏切换（弱断言） ============

  it("F11 触发全屏切换（不验证实际 OS 全屏状态）", async () => {
    // F11 在 tauri-driver 下可能无法真正切换 OS 全屏，且全屏后 WebView2
    // 的 DOM 查询行为不稳定（.cm-editor 可能暂时不可见）。
    // 此用例只验证 keydown 不抛异常 + session 仍响应（execute 可调用）。
    await pressShortcut(browser, "F11");
    await browser.pause(500);

    // 验证 session 仍响应：execute 一个简单表达式
    const alive = await browser.execute(() => document.readyState).catch(() => null);
    expect(alive).toBe("complete");

    // 再次按 F11 恢复（避免影响后续测试）
    await pressShortcut(browser, "F11");
    await browser.pause(500);

    // 恢复后验证编辑器可见
    const editor = await browser.$(".cm-editor");
    await editor.waitForExist({ timeout: 10000 });
  });
});
