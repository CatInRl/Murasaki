/**
 * 设置保存后运行时生效 E2E 测试（问题 1+2 / Ticket #80 设置保存事件）
 *
 * 验证：
 * - 1.1 emit "settings://saved" event 后主窗口 persistence.settings 被刷新（loadSettings 副作用）
 * - 1.2 emit "settings://saved" event 携带 editorMode=wysiwyg 后编辑器进入 wysiwyg 模式
 *
 * 通过 Tauri event API 模拟设置窗口（SettingsApp.vue）保存触发的 `settings://saved` 事件，
 * 验证主窗口 App.vue 中注册的 listener 会调用 persistence.loadSettings() 从磁盘重新加载
 * 设置，并通过 watch (() => persistence.settings.editorMode) 同步到 editorBridge。
 *
 * 关键：模拟"设置窗口保存了新设置到磁盘，但主窗口内存仍是旧值"的场景。
 * 1. updateSettings({ editorMode: "wysiwyg" }) 写盘 + 更新内存
 * 2. 直接 mutate persistence.settings.editorMode = "source"（仅内存，不 save）
 *    —— 此时磁盘 = wysiwyg，内存 = source
 * 3. emit "settings://saved" event
 * 4. listener 调用 loadSettings() 从磁盘重载 → 内存 = wysiwyg
 * 5. watch 触发 editorBridge.setEditorMode("wysiwyg")
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace, defaultFixtureFiles } from "../helpers/fixtures";
import {
  openWorkspace,
  closeWorkspace,
  openFileInTab,
  closeAllTabs,
  waitForPinia,
} from "../helpers/store";

let browser: Browser;

describe("设置保存后运行时生效", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  beforeEach(async () => {
    try { await closeAllTabs(browser); } catch { /* ignore */ }
    try { await closeWorkspace(browser); } catch { /* ignore */ }
  });

  it("emit settings://saved 后主窗口 persistence.settings 被刷新", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    // 等待编辑器渲染
    const editorPane = await browser.$(".editor-pane");
    await editorPane.waitForExist({ timeout: 10000 });

    // 1. 写入 wysiwyg 到磁盘（updateSettings 同时更新内存 + 磁盘 + Rust 缓存）
    await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const persistence = pinia._s.get("persistence");
      Promise.resolve(persistence.updateSettings({ editorMode: "wysiwyg" }))
        .then(() => done(null))
        .catch((err: unknown) => done(err ? String(err) : null));
    });
    await browser.pause(300);

    // 2. 回滚内存（直接修改 settings 对象，不调用 save）
    //    此时：磁盘/Rust 缓存 = wysiwyg，JS 内存 = source
    await browser.execute(() => {
      // @ts-ignore
      const persistence = window.__pinia__._s.get("persistence");
      persistence.settings.editorMode = "source";
    });
    await browser.pause(300);

    // 验证回滚成功：内存应为 source
    let memMode = await browser.execute(() =>
      // @ts-ignore
      window.__pinia__._s.get("persistence").settings.editorMode
    );
    expect(memMode).toBe("source");

    // 3. emit settings://saved event（模拟设置窗口保存）
    await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "settings://saved",
        payload: { settings: { editorMode: "wysiwyg" } },
      }).then(
        () => done(null),
        (err: unknown) => done(err ? String(err) : null)
      );
    });

    // 4. 等待 listener 处理（loadSettings 是异步的）
    await browser.pause(500);

    // 5. 验证 persistence.settings 被刷新为 wysiwyg（从磁盘/Rust 缓存重载）
    memMode = await browser.execute(() =>
      // @ts-ignore
      window.__pinia__._s.get("persistence").settings.editorMode
    );
    expect(memMode).toBe("wysiwyg");
  });

  it("emit settings://saved 携带 editorMode=wysiwyg 后编辑器进入 wysiwyg 模式", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    const editorPane = await browser.$(".editor-pane");
    await editorPane.waitForExist({ timeout: 10000 });

    // 1. 初始设为 source（磁盘 + 内存）
    await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const persistence = pinia._s.get("persistence");
      Promise.resolve(persistence.updateSettings({ editorMode: "source" }))
        .then(() => done(null))
        .catch((err: unknown) => done(err ? String(err) : null));
    });
    await browser.pause(300);

    // 2. 写入 wysiwyg 到磁盘，但回滚内存为 source
    //    此时：磁盘 = wysiwyg，内存 = source，editorBridge = source
    await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const persistence = pinia._s.get("persistence");
      Promise.resolve(persistence.updateSettings({ editorMode: "wysiwyg" }))
        .then(() => {
          // 回滚内存（不调用 save）：磁盘仍是 wysiwyg
          persistence.settings.editorMode = "source";
          done(null);
        })
        .catch((err: unknown) => done(err ? String(err) : null));
    });
    await browser.pause(300);

    // 验证 editorBridge 当前为 source（watch 已触发）
    let editorMode = await browser.execute(() =>
      // @ts-ignore
      window.__pinia__._s.get("editorBridge").editorMode
    );
    expect(editorMode).toBe("source");

    // 3. emit settings://saved（模拟设置窗口保存）
    await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "settings://saved",
        payload: { settings: { editorMode: "wysiwyg" } },
      }).then(
        () => done(null),
        (err: unknown) => done(err ? String(err) : null)
      );
    });

    // 4. 等待 listener + watch + Vue 渲染
    await browser.pause(600);

    // 5. 验证 editorBridge.editorMode === "wysiwyg"
    editorMode = await browser.execute(() =>
      // @ts-ignore
      window.__pinia__._s.get("editorBridge").editorMode
    );
    expect(editorMode).toBe("wysiwyg");

    // 6. 验证 .editor-pane 有 mode-wysiwyg class
    const cls = await editorPane.getAttribute("class");
    expect(cls).toContain("mode-wysiwyg");
  });
});
