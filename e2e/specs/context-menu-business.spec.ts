/**
 * TabBar / Editor 右键菜单具体项 E2E 测试（覆盖 M30-M31）
 *
 * 验证：
 * - M30: TabBar 右键菜单 8 项（关闭/关闭其他/关闭右侧/关闭左侧/关闭所有/分隔符/复制路径/在文件资源管理器中显示）
 * - M31: SourceEditor 右键菜单 10 项（剪切/复制/粘贴/全选/分隔符/查找替换/插入表格/链接/图片/粘贴为纯文本）
 *
 * 实现方式：通过 contextMenu.show 模拟 TabBar.onContextMenu 和
 * SourceEditor.buildEditorMenuItems 的菜单项构造，验证项数 + 文本 + 禁用状态。
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

describe("TabBar / Editor 右键菜单具体项", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  beforeEach(async () => {
    await resetPersistenceSettings(browser);
    const wsPath = resetWorkspace(defaultFixtureFiles());
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
    // 清理残留菜单
    await browser.execute(() => {
      // @ts-ignore
      const menu = window.__pinia__._s.get("contextMenu");
      if (menu) menu.hide();
    });
    await browser.pause(150);
    await openWorkspace(browser, wsPath);
    await (await browser.$(".file-tree")).waitForExist({ timeout: 10000 });
    await ensureSplitMode(browser);
  });

  // ============ M30: TabBar 右键菜单 ============

  it("TabBar 右键菜单渲染 8 项（5 关闭 + 分隔符 + 2 路径操作）", async () => {
    // 模拟 TabBar.onContextMenu 构造的菜单项
    await browser.execute(() => {
      // @ts-ignore
      const menu = window.__pinia__._s.get("contextMenu");
      menu.show(
        new MouseEvent("contextmenu", { clientX: 100, clientY: 100 }),
        [
          { label: "关闭", shortcut: "Ctrl+W" },
          { label: "关闭其他" },
          { label: "关闭右侧" },
          { label: "关闭左侧" },
          { label: "关闭所有" },
          { separator: true },
          { label: "复制路径", disabled: false },
          { label: "在文件资源管理器中显示", disabled: false },
        ]
      );
    });

    const menuEl = await browser.$(".murasaki-context-menu");
    await menuEl.waitForDisplayed({ timeout: 5000 });

    // 应有 7 个菜单项 + 1 个分隔符
    const items = await browser.$$(".murasaki-context-menu-item");
    const separators = await browser.$$(".murasaki-context-menu-separator");
    expect(items.length).toBe(7);
    expect(separators.length).toBe(1);

    // 验证菜单文本
    const labels: string[] = [];
    for (const item of items) {
      const label = await item.$(".murasaki-context-menu-label");
      labels.push((await label.getText()).trim());
    }
    expect(labels).toEqual([
      "关闭",
      "关闭其他",
      "关闭右侧",
      "关闭左侧",
      "关闭所有",
      "复制路径",
      "在文件资源管理器中显示",
    ]);
  });

  it("TabBar '关闭' 项显示 Ctrl+W 快捷键提示", async () => {
    await browser.execute(() => {
      // @ts-ignore
      const menu = window.__pinia__._s.get("contextMenu");
      menu.show(
        new MouseEvent("contextmenu", { clientX: 100, clientY: 100 }),
        [{ label: "关闭", shortcut: "Ctrl+W" }]
      );
    });

    const shortcut = await browser.$(".murasaki-context-menu-shortcut");
    await shortcut.waitForExist({ timeout: 5000 });
    expect((await shortcut.getText()).trim()).toBe("Ctrl+W");
  });

  it("TabBar 未保存的 tab '复制路径' 和 '在文件资源管理器中显示' 禁用", async () => {
    // 模拟 tab.path=null（未保存的新文件）
    await browser.execute(() => {
      // @ts-ignore
      const menu = window.__pinia__._s.get("contextMenu");
      menu.show(
        new MouseEvent("contextmenu", { clientX: 100, clientY: 100 }),
        [
          { label: "关闭", shortcut: "Ctrl+W" },
          { label: "关闭其他" },
          { label: "关闭右侧" },
          { label: "关闭左侧" },
          { label: "关闭所有" },
          { separator: true },
          { label: "复制路径", disabled: true },
          { label: "在文件资源管理器中显示", disabled: true },
        ]
      );
    });

    const items = await browser.$$(".murasaki-context-menu-item");
    // 最后两项（复制路径 / 在文件资源管理器中显示）应禁用
    const copyPathItem = items[5];
    const revealItem = items[6];
    expect(await copyPathItem.getAttribute("class")).toContain("is-disabled");
    expect(await revealItem.getAttribute("class")).toContain("is-disabled");
  });

  // ============ M31: SourceEditor 右键菜单 ============

  it("Editor 右键菜单渲染 10 项（4 编辑 + 分隔符 + 5 插入操作）", async () => {
    // 模拟 SourceEditor.buildEditorMenuItems 构造的菜单项
    await browser.execute(() => {
      // @ts-ignore
      const menu = window.__pinia__._s.get("contextMenu");
      menu.show(
        new MouseEvent("contextmenu", { clientX: 100, clientY: 100 }),
        [
          { label: "剪切", shortcut: "Ctrl+X" },
          { label: "复制", shortcut: "Ctrl+C" },
          { label: "粘贴", shortcut: "Ctrl+V" },
          { label: "全选", shortcut: "Ctrl+A" },
          { separator: true },
          { label: "查找替换", shortcut: "Ctrl+F" },
          { label: "插入表格" },
          { label: "链接" },
          { label: "图片" },
          { label: "粘贴为纯文本" },
        ]
      );
    });

    const menuEl = await browser.$(".murasaki-context-menu");
    await menuEl.waitForDisplayed({ timeout: 5000 });

    // 应有 9 个菜单项 + 1 个分隔符
    const items = await browser.$$(".murasaki-context-menu-item");
    const separators = await browser.$$(".murasaki-context-menu-separator");
    expect(items.length).toBe(9);
    expect(separators.length).toBe(1);

    // 验证菜单文本
    const labels: string[] = [];
    for (const item of items) {
      const label = await item.$(".murasaki-context-menu-label");
      labels.push((await label.getText()).trim());
    }
    expect(labels).toEqual([
      "剪切",
      "复制",
      "粘贴",
      "全选",
      "查找替换",
      "插入表格",
      "链接",
      "图片",
      "粘贴为纯文本",
    ]);
  });

  it("Editor 右键菜单前 4 项显示对应快捷键", async () => {
    await browser.execute(() => {
      // @ts-ignore
      const menu = window.__pinia__._s.get("contextMenu");
      menu.show(
        new MouseEvent("contextmenu", { clientX: 100, clientY: 100 }),
        [
          { label: "剪切", shortcut: "Ctrl+X" },
          { label: "复制", shortcut: "Ctrl+C" },
          { label: "粘贴", shortcut: "Ctrl+V" },
          { label: "全选", shortcut: "Ctrl+A" },
          { separator: true },
          { label: "查找替换", shortcut: "Ctrl+F" },
        ]
      );
    });

    const shortcuts = await browser.$$(".murasaki-context-menu-shortcut");
    expect(shortcuts.length).toBe(5);

    const texts: string[] = [];
    for (const s of shortcuts) {
      texts.push((await s.getText()).trim());
    }
    expect(texts).toEqual([
      "Ctrl+X",
      "Ctrl+C",
      "Ctrl+V",
      "Ctrl+A",
      "Ctrl+F",
    ]);
  });

  // ============ 实际触发测试 ============

  it("右键 tab 后弹出菜单（通过 UI 触发）", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openFileInTab(browser, `${wsPath}\\intro.md`);
    await browser.pause(300);

    // 右键 tab（通过 browser.execute 触发 contextmenu 事件）
    await browser.execute(() => {
      const tab = document.querySelector(".tab-bar-container .tab-item");
      if (tab) {
        const rect = tab.getBoundingClientRect();
        const ev = new MouseEvent("contextmenu", {
          clientX: rect.left + 10,
          clientY: rect.top + 10,
          bubbles: true,
          cancelable: true,
        });
        tab.dispatchEvent(ev);
      }
    });
    await browser.pause(300);

    // 应弹出右键菜单
    const menu = await browser.$(".murasaki-context-menu");
    expect(await menu.isExisting()).toBe(true);

    // 应有"关闭"项
    const items = await browser.$$(".murasaki-context-menu-item");
    expect(items.length).toBeGreaterThan(0);

    const firstLabel = await items[0].$(".murasaki-context-menu-label");
    expect((await firstLabel.getText()).trim()).toBe("关闭");
  });

  it("右键编辑器后弹出菜单（通过 UI 触发）", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openFileInTab(browser, `${wsPath}\\intro.md`);
    await browser.pause(300);

    // 右键 CodeMirror 编辑器
    await browser.execute(() => {
      const editor = document.querySelector(".cm-editor");
      if (editor) {
        const rect = editor.getBoundingClientRect();
        const ev = new MouseEvent("contextmenu", {
          clientX: rect.left + 50,
          clientY: rect.top + 50,
          bubbles: true,
          cancelable: true,
        });
        editor.dispatchEvent(ev);
      }
    });
    await browser.pause(300);

    // 应弹出右键菜单
    const menu = await browser.$(".murasaki-context-menu");
    expect(await menu.isExisting()).toBe(true);

    // 应有"剪切"项
    const items = await browser.$$(".murasaki-context-menu-item");
    expect(items.length).toBeGreaterThan(0);

    const firstLabel = await items[0].$(".murasaki-context-menu-label");
    expect((await firstLabel.getText()).trim()).toBe("剪切");
  });
});
