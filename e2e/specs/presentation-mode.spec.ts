/**
 * 演示模式 E2E 测试（0.9.0 / #180 演示模式 + #181 缩放）
 *
 * 验证：
 * - Ctrl+Shift+4 切到演示模式：只挂预览、无编辑器/工具栏/分隔条
 * - 内容只读（无 CodeMirror 实例、任务列表 checkbox 禁用）
 * - 状态栏显示「演示」模式 chip 与缩放 chip（默认 100%）
 * - Ctrl+= / Ctrl+- / Ctrl+0 缩放 50%–200%、步进 10%
 * - 缩放值持久化到 settings.presentationZoom
 * - source-only 文件（.txt）强制降级为源码模式
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import {
  resetWorkspace,
  defaultFixtureFiles,
  type FixtureFile,
} from "../helpers/fixtures";
import {
  openWorkspace,
  closeWorkspace,
  closeAllTabs,
  openFileInTab,
  waitForPinia,
  dismissAllDialogs,
  resetPersistenceSettings,
} from "../helpers/store";

let browser: Browser;
let wsPath: string;

/** 通过 dispatchEvent 触发 keydown（App.vue 的 onKeyDown 监听 window） */
async function pressShortcut(
  b: Browser,
  key: string,
  opts: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}
): Promise<void> {
  await b.execute(
    (k: string, c: boolean, s: boolean, a: boolean) => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: k,
          bubbles: true,
          cancelable: true,
          ctrlKey: c,
          shiftKey: s,
          altKey: a,
        })
      );
    },
    key,
    !!opts.ctrl,
    !!opts.shift,
    !!opts.alt
  );
  await b.pause(400);
}

/** 当前持久化的演示缩放百分比 */
async function getZoom(b: Browser): Promise<number> {
  return b.execute(() => {
    // @ts-ignore
    return window.__pinia__._s.get("persistence").settings.presentationZoom;
  });
}

/** 重置演示缩放（persistence.presentationZoom 不在 resetPersistenceSettings 覆盖范围内） */
async function resetZoom(b: Browser): Promise<void> {
  await b.executeAsync((done: (res: unknown) => void) => {
    // @ts-ignore
    const persistence = window.__pinia__._s.get("persistence");
    Promise.resolve(persistence.updateSettings({ presentationZoom: 100 }))
      .then(() => done(null))
      .catch((err: unknown) => done(err ? String(err) : null));
  });
  await b.pause(200);
}

function presentationFixtures(): FixtureFile[] {
  return [
    ...defaultFixtureFiles(),
    { path: "plain.txt", content: "纯文本内容，不支持预览渲染。" },
  ];
}

describe("演示模式", () => {
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
    wsPath = resetWorkspace(presentationFixtures());
    await resetZoom(browser);
  });

  it("Ctrl+Shift+4 切到演示模式：只挂预览，无工具栏/编辑器/分隔条", async () => {
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    // Ctrl+Shift+4 → e.key 为上档字符 "$"（"!" 是 Ctrl+Shift+1，切的是源码模式）
    await pressShortcut(browser, "$", { ctrl: true, shift: true });

    await browser.waitUntil(
      async () => (await browser.$(".editor-pane.mode-presentation")).isExisting(),
      { timeout: 10000 }
    );

    expect(await (await browser.$(".editor-toolbar")).isExisting()).toBe(false);
    expect(await (await browser.$(".pane-left")).isExisting()).toBe(false);
    expect(await (await browser.$(".splitter")).isExisting()).toBe(false);
    // 预览铺满
    expect(await (await browser.$(".preview-zoom")).isExisting()).toBe(true);
    expect(await (await browser.$(".preview-pane")).isExisting()).toBe(true);
  });

  it("演示模式只读：无 CodeMirror 实例，任务列表 checkbox 禁用", async () => {
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);
    await pressShortcut(browser, "$", { ctrl: true, shift: true });
    await browser.waitUntil(
      async () => (await browser.$(".editor-pane.mode-presentation")).isExisting(),
      { timeout: 10000 }
    );

    // 编辑器未挂载
    expect(await (await browser.$(".cm-editor")).isExisting()).toBe(false);

    // intro.md 含任务列表 `- [ ] 协作模式`
    const boxes = await browser.$$('.preview-pane input[type="checkbox"]');
    expect(boxes.length).toBeGreaterThan(0);
    // 任务列表 checkbox 只读：实现是在预览区点击时 preventDefault 取消激活行为、
    // 不写回源码（见 PreviewPane.vue 的 readonly 分支），**不设 disabled 属性**，
    // 因此断言「点击后勾选状态不变」而非 isEnabled() === false
    for (const box of boxes) {
      const checkedBefore = await box.isSelected();
      await box.click();
      await browser.pause(100);
      expect(await box.isSelected()).toBe(checkedBefore);
    }
  });

  it("状态栏显示「演示」模式 chip 与 100% 缩放 chip", async () => {
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);
    await pressShortcut(browser, "$", { ctrl: true, shift: true });

    const modeChip = await browser.$(".status-mode-chip");
    await modeChip.waitForExist({ timeout: 10000 });
    expect((await modeChip.getText()).trim()).toBe("演示模式");

    const zoomChip = await browser.$(".status-zoom-chip");
    await zoomChip.waitForExist({ timeout: 5000 });
    expect((await zoomChip.getText()).trim()).toContain("100%");
  });

  it("Ctrl+= / Ctrl+- 步进 10%，Ctrl+0 复位，并持久化", async () => {
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);
    await pressShortcut(browser, "$", { ctrl: true, shift: true });

    const zoomChip = await browser.$(".status-zoom-chip");
    await zoomChip.waitForExist({ timeout: 10000 });

    await pressShortcut(browser, "=", { ctrl: true });
    expect(await getZoom(browser)).toBe(110);
    expect((await zoomChip.getText()).trim()).toContain("110%");

    await pressShortcut(browser, "-", { ctrl: true });
    expect(await getZoom(browser)).toBe(100);

    // 下界：连续缩小不会低于 50%
    for (let i = 0; i < 8; i++) {
      await pressShortcut(browser, "-", { ctrl: true });
    }
    expect(await getZoom(browser)).toBe(50);

    // 上界：连续放大不会超过 200%
    for (let i = 0; i < 20; i++) {
      await pressShortcut(browser, "=", { ctrl: true });
    }
    expect(await getZoom(browser)).toBe(200);

    await pressShortcut(browser, "0", { ctrl: true });
    await browser.waitUntil(async () => (await getZoom(browser)) === 100, {
      timeout: 5000,
    });
    expect((await zoomChip.getText()).trim()).toContain("100%");
  });

  it("非演示模式下缩放快捷键不生效", async () => {
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);
    // 默认 split 模式
    expect(await getZoom(browser)).toBe(100);

    await pressShortcut(browser, "=", { ctrl: true });
    expect(await getZoom(browser)).toBe(100);
  });

  it("source-only 文件（.txt）强制降级为源码模式", async () => {
    await openWorkspace(browser, wsPath);
    // 先在 md 上进入演示模式
    await openFileInTab(browser, `${wsPath}\\intro.md`);
    await pressShortcut(browser, "$", { ctrl: true, shift: true });
    await browser.waitUntil(
      async () => (await browser.$(".editor-pane.mode-presentation")).isExisting(),
      { timeout: 10000 }
    );

    // 切到 .txt：降级为源码模式
    await openFileInTab(browser, `${wsPath}\\plain.txt`);
    await browser.waitUntil(
      async () => (await browser.$(".editor-pane.mode-source")).isExisting(),
      { timeout: 10000 }
    );
    expect(await (await browser.$(".editor-pane.mode-presentation")).isExisting()).toBe(
      false
    );
    // 且不写回 settings（保留 md 的最后一次选择）
    await browser.waitUntil(async () => {
      const mode = await browser.execute(() => {
        // @ts-ignore
        return window.__pinia__._s.get("persistence").settings.editorMode;
      });
      return mode === "presentation";
    }, { timeout: 5000 });
  });
});
