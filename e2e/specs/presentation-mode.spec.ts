/**
 * 演示模式 E2E 测试（0.9.0 / #180 演示模式 + #181 缩放）
 *
 * 验证：
 * - Ctrl+Shift+4 切到演示模式：只挂预览、无编辑器/工具栏/分隔条
 * - 内容只读（无 CodeMirror 实例、任务列表 checkbox 点击后状态不变）
 * - 状态栏显示「演示」模式 chip 与缩放 chip（默认 100%）
 * - Ctrl+= / Ctrl+- / Ctrl+0 缩放 50%–200%、步进 10%
 * - 缩放值持久化到 settings.presentationZoom
 * - source-only 文件（.txt）强制降级为源码模式
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
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
  ensureSplitMode,
} from "../helpers/store";
import { readText, waitForAbsent, waitForInBrowser, waitForPresent } from "../helpers/wait";

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
    {
      // HTML 演示模式的缩放回归夹具（#405）：内容要够长，让子文档自身可滚动
      // （真实滚轮会被子文档消费掉，正是「父文档收不到事件」的复现条件）。
      path: "page.html",
      content: [
        "<!DOCTYPE html>",
        '<html lang="zh-CN"><head><meta charset="utf-8"><title>页面</title></head>',
        '<body style="margin:0">',
        '<h1 style="margin:16px">HTML 演示页</h1>',
        '<div style="height:2000px;background:linear-gradient(#fff,#ddd)"></div>',
        "</body></html>",
      ].join("\n"),
    },
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

  afterEach(async () => {
    // 收尾：关掉本用例打开的标签。标签会持久化到 tabs.json，而下一个 spec（如
    // tabs.spec）启动时会 restore 出来；其 beforeEach 重置工作区会把这些仍打开的
    // 文件删掉，触发「文件已被外部删除」模态告警遮挡点击。这里清干净即断掉泄漏。
    if (!browser) return;
    try {
      await closeAllTabs(browser);
    } catch {
      /* ignore */
    }
    await browser.pause(200);
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

  it("演示模式只读：无 CodeMirror 实例，任务列表 checkbox 点击不改变状态", async () => {
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

    await waitForPresent(browser, ".status-mode-chip", 10000);
    expect(await readText(browser, ".status-mode-chip", "演示模式")).toBe("演示模式");

    await waitForPresent(browser, ".status-zoom-chip", 5000);
    expect(await readText(browser, ".status-zoom-chip", /100%/)).toContain("100%");
  });

  it("Ctrl+= / Ctrl+- 步进 10%，Ctrl+0 复位，并持久化", async () => {
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);
    await pressShortcut(browser, "$", { ctrl: true, shift: true });

    await waitForPresent(browser, ".status-zoom-chip", 10000);

    await pressShortcut(browser, "=", { ctrl: true });
    expect(await getZoom(browser)).toBe(110);
    expect(await readText(browser, ".status-zoom-chip", /110%/)).toContain("110%");

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
    expect(await readText(browser, ".status-zoom-chip", /100%/)).toContain("100%");
  });

  it("放大后预览仍占满编辑区宽度（#337）", async () => {
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);
    await pressShortcut(browser, "$", { ctrl: true, shift: true });
    await waitForPresent(browser, ".preview-zoom", 10000);

    // 放大到 200%
    for (let i = 0; i < 10; i++) {
      await pressShortcut(browser, "=", { ctrl: true });
    }
    await browser.waitUntil(async () => (await getZoom(browser)) === 200, {
      timeout: 5000,
      interval: 100,
    });

    // 用视觉命中测试（elementFromPoint 按**缩放后的视觉布局**判定）：面板左右边缘都应落在
    // 缩放包裹层内。此前包裹层还额外写了 `width: calc(100% / z)`，等于重复补偿 —— 放大后
    // 只剩面板宽度的 1/z，右缘会落到 .pane-right 上而不是 .preview-zoom 里。
    const hits = (await browser.execute(() => {
      const pane = document.querySelector(".pane-right") as HTMLElement | null;
      if (!pane) return null;
      const rect = pane.getBoundingClientRect();
      const y = Math.round(rect.top + rect.height / 2);
      const left = document.elementFromPoint(Math.round(rect.left + 6), y);
      const right = document.elementFromPoint(Math.round(rect.right - 6), y);
      return {
        paneW: Math.round(rect.width),
        leftInBox: !!left && !!left.closest(".preview-zoom"),
        rightInBox: !!right && !!right.closest(".preview-zoom"),
      };
    })) as { paneW: number; leftInBox: boolean; rightInBox: boolean } | null;

    expect(hits?.paneW ?? 0).toBeGreaterThan(100);
    expect(hits?.leftInBox).toBe(true);
    expect(hits?.rightInBox).toBe(true);
  });

  it("HTML 文件演示模式下同样可缩放（iframe 内事件接回父文档，#405）", async () => {
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\page.html`);
    await pressShortcut(browser, "$", { ctrl: true, shift: true });
    await waitForPresent(browser, ".editor-pane.mode-presentation", 10000);
    await waitForPresent(browser, ".html-iframe", 10000);
    // 等父侧把 wheel / keydown 监听挂上：HtmlPreview 幂等轮询挂载后会在子文档
    // documentElement 上打 data-murasaki-events-attached 标记。标记只打在 srcdoc
    // 正式文档上（轮询会跳过 about:blank 占位文档——WebKit 系上它同样有完整的
    // documentElement，监听若挂上去会被随后加载的 srcdoc 文档整体替换，这是
    // #405 第二次 CI 双平台失败的根因），因此看到标记即当前文档已是最终文档。
    await waitForInBrowser(
      browser,
      () => {
        const fr = document.querySelector(".html-iframe") as HTMLIFrameElement | null;
        return fr?.contentDocument?.documentElement?.dataset.murasakiEventsAttached === "1";
      },
      [],
      { message: "HTML 预览子文档监听未挂载（murasakiEventsAttached 未置位）" }
    );

    // 记录 WebView2 整页缩放观测点：devicePixelRatio 随浏览器级缩放变化，应用层
    // zoom（presentationZoomStyle）不改它。若 keydown 的取消没回传到子文档原始
    // 事件，Ctrl+= 会让 WebView2 浏览器加速键同时整页缩放，DPR 就会变。
    const dprBefore = await browser.execute(() => window.devicePixelRatio);

    // 1) Ctrl+滚轮：真实滚轮事件落在子文档里（父文档完全收不到），只能由父侧在
    //    contentDocument 上补挂的监听器接回。修好之前这里会一直是 100%。
    //    「监听挂在当前文档上」的检查与 dispatch 必须在同一次 execute 内同步完成
    //    ——拆成两次 IPC 的话，中间文档可能被替换，事件会派到没有监听的新文档上；
    //    并以 zoom 是否到位作为整体重试条件兜底（每轮重新拿文档、重新派发）。
    await browser.waitUntil(
      async () => {
        const dispatched = (await browser.execute(() => {
          const fr = document.querySelector(".html-iframe") as HTMLIFrameElement | null;
          const doc = fr?.contentDocument;
          if (!doc || doc.documentElement.dataset.murasakiEventsAttached !== "1") return false;
          const view = fr?.contentWindow as (Window & typeof globalThis) | null;
          if (!view) return false;
          doc.dispatchEvent(
            new view.WheelEvent("wheel", {
              ctrlKey: true,
              deltaY: -120,
              bubbles: true,
              cancelable: true,
            })
          );
          return true;
        })) as boolean;
        return dispatched && (await getZoom(browser)) === 110;
      },
      {
        timeout: 5000,
        timeoutMsg: "子文档 Ctrl+滚轮后 zoom 未到 110（#405 wheel 接回失效）",
      }
    );
    expect(await readText(browser, ".status-zoom-chip", /110%/)).toContain("110%");

    // 2) 焦点进入 iframe 后的 Ctrl+=：keydown 发生在子文档里，父 window 收不到，
    //    须由父侧重派发回 window 才能走既有的快捷键系统；取消行为也要回传原始
    //    事件，否则 WebView2 浏览器加速键会同时整页缩放（用 DPR 断言）
    await (await browser.$(".html-iframe")).click();
    await browser.keys(["Control", "="]);
    await browser.waitUntil(async () => (await getZoom(browser)) === 120, {
      timeout: 5000,
      timeoutMsg: "iframe 内 Ctrl+= 后 zoom 未到 120（#405 keydown 接回失效）",
    });
    expect(await browser.execute(() => window.devicePixelRatio)).toBe(dprBefore);

    // 3) Ctrl+- 缩小
    await browser.keys(["Control", "-"]);
    await browser.waitUntil(async () => (await getZoom(browser)) === 110, {
      timeout: 5000,
      timeoutMsg: "iframe 内 Ctrl+- 后 zoom 未回到 110",
    });

    // 4) 焦点在 iframe 内时其它全局快捷键同样可达（#405 验收 3）：
    //    Ctrl+P 拉起统一搜索条，Esc 关闭
    await browser.keys(["Control", "p"]);
    await waitForPresent(browser, ".gsb", 5000);
    await browser.keys(["Escape"]);
    await waitForAbsent(browser, ".gsb", 5000);

    // 5) Ctrl+0 复位
    await browser.keys(["Control", "0"]);
    await browser.waitUntil(async () => (await getZoom(browser)) === 100, {
      timeout: 5000,
      timeoutMsg: "iframe 内 Ctrl+0 后 zoom 未复位到 100",
    });
  });

  it("HTML 分屏（非演示模式）下 Ctrl+滚轮不缩放（#405 验收：非演示行为不变）", async () => {
    await ensureSplitMode(browser);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\page.html`);
    await waitForPresent(browser, ".html-iframe", 10000);
    await waitForInBrowser(
      browser,
      () => {
        const fr = document.querySelector(".html-iframe") as HTMLIFrameElement | null;
        return fr?.contentDocument?.documentElement?.dataset.murasakiEventsAttached === "1";
      },
      [],
      { message: "HTML 预览子文档监听未挂载（murasakiEventsAttached 未置位）" }
    );

    // 同演示用例：检查与派发放进同一次 execute，防两次 IPC 之间文档被替换后
    // 派到没有监听的新文档上（那样断言会平凡通过，测不到「接回后仍不缩放」）
    await browser.execute(() => {
      const fr = document.querySelector(".html-iframe") as HTMLIFrameElement | null;
      const doc = fr?.contentDocument;
      if (!doc || doc.documentElement.dataset.murasakiEventsAttached !== "1") {
        throw new Error("listeners not attached to current html iframe document");
      }
      const view = fr?.contentWindow as (Window & typeof globalThis) | null;
      if (!view) throw new Error("html iframe not ready");
      doc.dispatchEvent(
        new view.WheelEvent("wheel", {
          ctrlKey: true,
          deltaY: -120,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    await browser.pause(500);
    expect(await getZoom(browser)).toBe(100);
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
