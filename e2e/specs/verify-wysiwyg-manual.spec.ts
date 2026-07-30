/**
 * WYSIWYG 模式真实用户路径验证（临时验证 spec）
 *
 * 验证打包应用（murasaki.exe）中 WYSIWYG 模式的端到端真实用户路径：
 * - 设置页单入口路由渲染（非空白）
 * - 设置保存后运行时切换到 WYSIWYG（无需重启，通过 settings://saved 事件）
 * - WYSIWYG 装饰正确渲染（标记隐藏 + 光标进入段后 dim）
 * - 编辑器内容区可见（非只有行号）
 *
 * 参考风格：wysiwyg-mode.spec.ts + settings-runtime.spec.ts + settings-window.spec.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace } from "../helpers/fixtures";
import { openWorkspace, openFileInTab, waitForPinia } from "../helpers/store";

describe("WYSIWYG 模式真实用户路径验证", () => {
  let browser: Browser;
  let wsPath: string;

  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  it("步骤1: 打开设置页（单入口路由，非空白）", async () => {
    // 先重置：emit navigate "editor" 确保初始无设置页残留
    await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "navigate",
        payload: "editor",
      }).then(
        () => done(null),
        (err: unknown) => done(err ? String(err) : null)
      );
    });
    await browser.pause(300);

    // 验证初始无设置页 DOM
    expect(await (await browser.$(".settings-shell")).isExisting()).toBe(false);

    // 调用 open_settings 命令（单入口路由：在主窗口内通过 navigate 事件切换）
    // 注意：invoke("open_settings") 的 Promise 不会 resolve（新窗口/路由切换阻塞 ack），
    // 用 setTimeout 延迟 done() 让 IPC 消息发送
    await browser.executeAsync((done: (res: unknown) => void) => {
      try {
        // @ts-ignore
        window.__TAURI_INTERNALS__.invoke("open_settings");
      } catch {
        // 忽略
      }
      setTimeout(() => done(null), 1000);
    });
    await browser.pause(1000);

    // 设置页 DOM 应在主窗口内渲染（非空白）
    const settingsShell = await browser.$(".settings-shell");
    await settingsShell.waitForExist({ timeout: 5000 });
    expect(await settingsShell.isExisting()).toBe(true);

    // 单入口路由：不应创建新窗口
    const handles = await browser.getWindowHandles();
    expect(handles.length).toBe(1);
  });

  it("步骤2: 切换到 WYSIWYG 模式并保存（emit settings://saved 运行时生效）", async () => {
    // 1. updateSettings 写盘 + 更新内存 + Rust 缓存
    await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const persistence = pinia._s.get("persistence");
      Promise.resolve(persistence.updateSettings({ editorMode: "wysiwyg" }))
        .then(() => done(null))
        .catch((err: unknown) => done(err ? String(err) : null));
    });
    await browser.pause(300);

    // 2. emit settings://saved 触发主窗口 loadSettings（模拟设置窗口保存）
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
    await browser.pause(500);

    // 3. 验证 persistence.settings.editorMode === "wysiwyg"
    const mode = await browser.execute(() =>
      // @ts-ignore
      window.__pinia__._s.get("persistence").settings.editorMode
    );
    expect(mode).toBe("wysiwyg");
  });

  it("步骤3: 关闭设置页并验证编辑器进入 WYSIWYG 模式", async () => {
    // 关闭设置页（navigate to editor）
    await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "navigate",
        payload: "editor",
      }).then(
        () => done(null),
        (err: unknown) => done(err ? String(err) : null)
      );
    });
    await browser.pause(300);

    // 验证设置页已关闭
    const settingsShell = await browser.$(".settings-shell");
    expect(await settingsShell.isExisting()).toBe(false);

    // 准备含 markdown 语法（标题 + 正文）的测试文件
    wsPath = resetWorkspace([
      { path: "wysiwyg-test.md", content: "# 大标题\n\n正文内容\n" },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\wysiwyg-test.md`);

    // 等待编辑器渲染
    const editorPane = await browser.$(".editor-pane");
    await editorPane.waitForExist({ timeout: 10000 });

    // 验证 editorBridge.editorMode === "wysiwyg"
    const mode = await browser.execute(() =>
      // @ts-ignore
      window.__pinia__._s.get("editorBridge").editorMode
    );
    expect(mode).toBe("wysiwyg");

    // 验证 .editor-pane 有 mode-wysiwyg class
    const cls = await editorPane.getAttribute("class");
    expect(cls).toContain("mode-wysiwyg");
  });

  it("步骤4: 验证 WYSIWYG 装饰渲染（标记隐藏）", async () => {
    // 移动光标到正文段（position 7 = "正"之前），使标题段脱离光标所在段落
    // "# 大标题\n\n正文内容\n" 中 position 7 是 "正"
    await browser.execute(() => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const editorBridge = pinia._s.get("editorBridge");
      const view = editorBridge.editorView;
      if (view) {
        view.dispatch({
          selection: { anchor: 7, head: 7 },
          scrollIntoView: false,
        });
        view.focus();
      }
    });
    // 等待 debounce (50ms) + recompute + render
    await browser.pause(600);

    // 诊断：检查 editorView 状态和装饰
    const diag = await browser.execute(() => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const editorBridge = pinia._s.get("editorBridge");
      const view = editorBridge.editorView;
      if (!view) return { error: "no editorView" };
      const state = view.state;
      const hideEls = view.dom.querySelectorAll(".murasaki-wysiwyg-mark-hide");
      const dimEls = view.dom.querySelectorAll(".murasaki-wysiwyg-mark-dim");
      return {
        cursorPos: state.selection.main.head,
        docLength: state.doc.length,
        docText: state.doc.toString().substring(0, 50),
        hideCount: hideEls.length,
        dimCount: dimEls.length,
        editorMode: editorBridge.editorMode,
      };
    });
    console.log("[diag] 步骤4 标记隐藏:", JSON.stringify(diag));

    // 验证 hide decoration 存在（光标不在标题段，# 标记应被隐藏）
    const hideMarks = await browser.$$(".murasaki-wysiwyg-mark-hide");
    expect(hideMarks.length).toBeGreaterThan(0);

    // 验证编辑器内容区可见（非空，非只有行号）
    const content = await browser.$(".cm-content");
    expect(await content.isExisting()).toBe(true);
    const text = await content.getText();
    expect(text.length).toBeGreaterThan(0);
  });

  it("步骤5: 验证光标进入段后标记显示（dim）", async () => {
    // 移动光标到标题段（position 0 = "#"），使标题段成为光标所在段落
    await browser.execute(() => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const editorBridge = pinia._s.get("editorBridge");
      const view = editorBridge.editorView;
      if (view) {
        view.dispatch({
          selection: { anchor: 0, head: 0 },
          scrollIntoView: false,
        });
        view.focus();
      }
    });
    await browser.pause(600);

    // 诊断
    const diag = await browser.execute(() => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const editorBridge = pinia._s.get("editorBridge");
      const view = editorBridge.editorView;
      if (!view) return { error: "no editorView" };
      const state = view.state;
      const hideEls = view.dom.querySelectorAll(".murasaki-wysiwyg-mark-hide");
      const dimEls = view.dom.querySelectorAll(".murasaki-wysiwyg-mark-dim");
      return {
        cursorPos: state.selection.main.head,
        hideCount: hideEls.length,
        dimCount: dimEls.length,
      };
    });
    console.log("[diag] 步骤5 光标进入段 dim:", JSON.stringify(diag));

    // 光标在标题段，标记应该 dim 可见（不隐藏）
    const dimMarks = await browser.$$(".murasaki-wysiwyg-mark-dim");
    expect(dimMarks.length).toBeGreaterThan(0);
  });

  it("步骤6: 验证编辑器内容区可见（综合验证，非只有行号）", async () => {
    // 综合验证：编辑器内容区可见且非空，包含标题和正文文本
    const content = await browser.$(".cm-content");
    expect(await content.isExisting()).toBe(true);
    expect(await content.isDisplayed()).toBe(true);

    const text = await content.getText();
    expect(text.length).toBeGreaterThan(0);
    // 应包含标题和正文文本（证明渲染了文档内容，不只是行号）
    expect(text).toContain("大标题");
    expect(text).toContain("正文内容");

    // 验证行号区也存在（编辑器结构完整）
    const gutters = await browser.$$(".cm-gutters");
    expect(gutters.length).toBeGreaterThan(0);
  });
});
