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
import { IS_LINUX, IS_MACOS } from "../helpers/platform";

// WebKit 系引擎（macOS WKWebView / Linux WebKitGTK）会整体吞掉脚本合成的子框架
// WheelEvent（#405 五轮 CI 定论：换派发目标、挂探针、重试均无效），合成 wheel
// 派发在这两个平台不能用于 e2e 断言
const IS_WEBKIT = IS_MACOS || IS_LINUX;

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

/**
 * 在 HTML 预览子文档内直派 keydown（#405）：焦点真实处于 iframe 里时，keydown
 * 就落在子文档、父 window 收不到，须走 HtmlPreview 的 keydown 监听 → inner-keydown
 * → EditorPane 重派回 window 的接回链路。用 execute 直派而非 browser.keys：不依赖
 * 焦点恰好落在 iframe 里，也不依赖宿主平台对合成键盘事件的处理，三平台行为一致。
 */
async function pressShortcutInHtmlDoc(
  b: Browser,
  key: string,
  opts: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}
): Promise<void> {
  await b.execute(
    (k: string, c: boolean, s: boolean, a: boolean) => {
      const fr = document.querySelector(".html-iframe") as HTMLIFrameElement | null;
      const doc = fr?.contentDocument;
      const view = fr?.contentWindow as (Window & typeof globalThis) | null;
      if (!doc || !view) throw new Error("html iframe not ready");
      // 派发前校验监听确实挂在当前文档上，防两次 IPC 之间文档被替换后派到
      // 没有监听的新文档（事件被静默丢弃，用例会以超时而非明确错误收场）
      if (doc.documentElement.dataset.murasakiEventsAttached !== "1") {
        throw new Error("listeners not attached to current html iframe document");
      }
      (doc.body ?? doc).dispatchEvent(
        new view.KeyboardEvent("keydown", {
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

/**
 * Windows（WebView2）专用：向 HTML 预览子文档派发合成 Ctrl+滚轮，等待 zoom 推到
 * 110（#405 wheel 接回的端到端验证）。
 *
 * 实现要点（历次 CI 失败沉淀）：
 * - 「监听挂在当前文档上」的检查、探针与 dispatch 必须在同一次 execute 内同步
 *   完成——拆成多次 IPC 的话，中间文档可能被替换，事件会派到没有监听的新文档
 *   上；并以 zoom 是否到位作为整体重试条件兜底（每轮重新拿文档、重新派发）。
 * - 每轮 dispatch 前临时挂只读探针，把「事件是否真的到达子文档监听、deltaY /
 *   ctrlKey 实际值、zoom 前后值」一并带回；超时时把最后一轮完整观测抛进错误，
 *   CI 注解可直接区分断点环节。
 * - 派发目标走 body 冒泡（与真实滚轮落元素再冒泡一致），双探针区分「target 收到」
 *   与「冒泡到 document」：target 收到而 document 没收到才是产品链路真断（转发
 *   监听没接到冒泡事件）。
 *
 * WebKit 系（macOS / Linux）不调用本函数：引擎会整体吞掉脚本合成的子框架
 * WheelEvent——第四轮换 body 目标后 macOS 注解 targetHits/docHits 仍双空、zoom
 * 不动（run 37442702866），Linux 同因失败；系引擎对合成 wheel 的处理而非产品
 * 链路断了，合成 wheel 在这两个平台无法用于断言（见 IS_WEBKIT）。
 */
async function wheelZoomHtmlPreviewTo110(b: Browser): Promise<void> {
  let lastWheelObs: unknown = null;
  try {
    await b.waitUntil(
      async () => {
        const obs = (await b.execute(() => {
          const fr = document.querySelector(".html-iframe") as HTMLIFrameElement | null;
          const doc = fr?.contentDocument;
          if (!doc || doc.documentElement.dataset.murasakiEventsAttached !== "1") {
            return { dispatched: false, reason: "flag-not-set" };
          }
          const body = doc.body;
          if (!body) return { dispatched: false, reason: "no-body" };
          const view = fr?.contentWindow as (Window & typeof globalThis) | null;
          if (!view) return { dispatched: false, reason: "no-content-window" };
          // @ts-ignore
          const persistence = window.__pinia__?._s?.get("persistence");
          const zoomBefore = persistence?.settings?.presentationZoom;
          // 防过冲：zoom 已到位就不再派发（避免 waitUntil 重试把 zoom 越推越高）
          if (zoomBefore === 110) {
            return { dispatched: false, reason: "already-110", zoomAfter: zoomBefore };
          }
          const targetHits: Array<{ deltaY: number; ctrlKey: boolean }> = [];
          const docHits: Array<{ deltaY: number; ctrlKey: boolean }> = [];
          const targetProbe = (ev: WheelEvent): void => {
            targetHits.push({ deltaY: ev.deltaY, ctrlKey: ev.ctrlKey });
          };
          const docProbe = (ev: WheelEvent): void => {
            docHits.push({ deltaY: ev.deltaY, ctrlKey: ev.ctrlKey });
          };
          body.addEventListener("wheel", targetProbe);
          doc.addEventListener("wheel", docProbe, { capture: true });
          let dispatchError: string | null = null;
          try {
            body.dispatchEvent(
              new view.WheelEvent("wheel", {
                ctrlKey: true,
                deltaY: -120,
                bubbles: true,
                cancelable: true,
              })
            );
          } catch (err) {
            dispatchError = String(err);
          } finally {
            body.removeEventListener("wheel", targetProbe);
            doc.removeEventListener("wheel", docProbe, { capture: true });
          }
          return {
            dispatched: dispatchError === null,
            dispatchError,
            targetHits,
            docHits,
            zoomBefore,
            zoomAfter: persistence?.settings?.presentationZoom,
          };
        })) as {
          dispatched: boolean;
          dispatchError: string | null;
          reason?: string;
          targetHits?: Array<{ deltaY: number; ctrlKey: boolean }>;
          docHits?: Array<{ deltaY: number; ctrlKey: boolean }>;
          zoomBefore?: number;
          zoomAfter?: number;
        };
        lastWheelObs = obs;
        return obs.zoomAfter === 110;
      },
      {
        timeout: 5000,
        interval: 200,
        timeoutMsg: "子文档 Ctrl+滚轮后 zoom 未到 110（#405 wheel 接回失效）",
      }
    );
  } catch {
    throw new Error(
      `子文档 Ctrl+滚轮后 zoom 未到 110（#405 wheel 接回失效）。最后一轮观测：${JSON.stringify(lastWheelObs)}`
    );
  }
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
    //    平台差异（#405 五轮 CI 定论）：WebKit 系（macOS WKWebView / Linux
    //    WebKitGTK）会把脚本合成的子框架 WheelEvent 整体吞掉——macOS 注解
    //    targetHits/docHits 双空、zoom 不动（run 37442702866），Linux 同因失败；
    //    这是引擎对合成 wheel 的处理，不是产品链路断了，换派发目标也无济于事。
    //    故 WebKit 上跳过合成 wheel 派发（监听挂载正确性已由上方 flag 等待覆盖），
    //    wheel 接回的端到端派发验证保留在 Windows（WebView2）上。
    if (IS_WEBKIT) {
      expect(await getZoom(browser)).toBe(100);
    } else {
      await wheelZoomHtmlPreviewTo110(browser);
    }
    const zoomAfterWheel = await getZoom(browser);
    const zoomChipPattern = new RegExp(`${zoomAfterWheel}%`);
    expect(await readText(browser, ".status-zoom-chip", zoomChipPattern)).toContain(
      `${zoomAfterWheel}%`
    );

    // 2) 缩放快捷键，注入口按平台选择（快捷键匹配按 e.key，与 e.code 无关）：
    //    - Windows：pressShortcutInHtmlDoc（execute 直派 keydown 进子文档），
    //      端到端覆盖「焦点在 iframe 内快捷键仍可达」的接回链路（HtmlPreview
    //      keydown 监听 → inner-keydown → EditorPane 重派回 window）。
    //    - WebKit 系：无法从测试侧向子框架注入合成输入——跨 realm 的
    //      dispatchEvent 被引擎整体吞掉（wheel 有同 execute 内双探针零命中的 CI
    //      定论 run 37442702866；keydown 有 flag 校验通过、派发不抛错仍零效果的
    //      CI 定论 run 37453204670），退而用父 window 直派（pressShortcut，三
    //      平台可靠），验证 HTML 演示页响应全局缩放快捷键（缩放命令只按演示
    //      模式设门、不按文件类型）；子框架 keydown 监听已挂载由上方 flag 等待
    //      保证，接回链路的端到端验证由 Windows job 覆盖。
    const pressKey: (key: string, opts?: { ctrl?: boolean }) => Promise<void> = IS_WEBKIT
      ? (key, opts) => pressShortcut(browser, key, opts)
      : (key, opts) => pressShortcutInHtmlDoc(browser, key, opts);
    await pressKey("=", { ctrl: true });
    await browser.waitUntil(async () => (await getZoom(browser)) === zoomAfterWheel + 10, {
      timeout: 5000,
      timeoutMsg: "iframe 内 Ctrl+= 后 zoom 未 +10（#405 keydown 接回失效）",
    });
    // 取消回传守卫：key 接回链路要求 proxy 的 defaultPrevented 回传到子文档原始
    // 事件。devicePixelRatio 只随浏览器级缩放变化，应用层 zoom 不改它；真实
    // Trusted 按键回归时，取消未回传会让浏览器加速键整页缩放、DPR 变化。
    expect(await browser.execute(() => window.devicePixelRatio)).toBe(dprBefore);

    // 3) Ctrl+- 缩小
    await pressKey("-", { ctrl: true });
    await browser.waitUntil(async () => (await getZoom(browser)) === zoomAfterWheel, {
      timeout: 5000,
      timeoutMsg: "iframe 内 Ctrl+- 后 zoom 未回落",
    });

    // 4) 焦点在 iframe 内时其它全局快捷键同样可达（#405 验收 3）：
    //    Ctrl+P 拉起统一搜索条，Esc 关闭。Escape 例外：搜索条的关闭逻辑绑在其
    //    根节点 @keydown 上（DOM 层而非 window 层），向 window 派发到不了，须在
    //    父文档内向其自动聚焦的输入框派发并让它冒泡到根节点。
    await pressKey("p", { ctrl: true });
    await waitForPresent(browser, ".gsb", 5000);
    await browser.execute(() => {
      const input = document.querySelector(".gsb input[type='text']");
      if (!input) throw new Error("统一搜索条输入框未找到");
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      );
    });
    await waitForAbsent(browser, ".gsb", 5000);

    // 5) Ctrl+0 复位（Windows 由 110% 复位；WebKit 上第 3 步已回到 100%，
    //    仍照常派发保持链路覆盖，断言首查即真不构成平台差异风险）
    await pressKey("0", { ctrl: true });
    await browser.waitUntil(async () => (await getZoom(browser)) === 100, {
      timeout: 5000,
      timeoutMsg: "iframe 内 Ctrl+0 后 zoom 未复位到 100",
    });
  });

  it("HTML 分屏下 Ctrl+滚轮与快捷键真实缩放（#412：分屏与演示共用同一接回链路）", async () => {
    if (IS_WEBKIT) {
      // WebKit 吞合成子框架 WheelEvent（见 IS_WEBKIT 注释），滚轮入口在这两个
      // 平台无法端到端断言；分屏缩放本身已由 Markdown 分屏快捷键用例覆盖，
      // iframe 接回链路（keydown 合成不分平台）已由上方演示模式用例覆盖。
      return;
    }
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

    // #412 前出口被 presentation 门控，分屏下状态在变内容不动；现分屏与演示
    // 共用同一 wheel 接回链路，复用演示用例的合成滚轮 helper（Windows 专用）
    // DPR 守卫（#412 验收 2）：devicePixelRatio 只随浏览器级整页缩放变化，
    // 应用层 zoom 不改它；若取消未回传，WebView2 加速键会整页缩放、DPR 变化
    const dprBefore = await browser.execute(() => window.devicePixelRatio);
    await wheelZoomHtmlPreviewTo110(browser);
    expect(await readText(browser, ".status-zoom-chip", /110%/)).toContain("110%");

    // 快捷键同链路可达（#412 验收 1「HTML iframe 与 Markdown 预览一致」）：
    // 焦点在子文档内 Ctrl+- 经 keydown 接回缩小（能走到这里的只有 Windows）
    await pressShortcutInHtmlDoc(browser, "-", { ctrl: true });
    await browser.waitUntil(async () => (await getZoom(browser)) === 100, {
      timeout: 5000,
      timeoutMsg: "HTML 分屏下 Ctrl+- 后 zoom 未回到 100（#412 出口未开）",
    });
    expect(await browser.execute(() => window.devicePixelRatio)).toBe(dprBefore);
  });

  it("分屏（Markdown 预览）下缩放快捷键真实生效（#412）", async () => {
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);
    // 默认 split 模式：有预览区，缩放 chip 常驻（#412 前 chip 是演示模式专属）
    await waitForPresent(browser, ".status-zoom-chip", 5000);
    expect(await getZoom(browser)).toBe(100);
    await waitForPresent(browser, ".markdown-body h1", 5000);

    // 渲染尺寸基线：块级内容的视觉宽度可能被「zoom 下百分比按缩放后的包含块
    // 解析」抵住不变（#337），文字高度是稳定的变化信号；只断言变大，不做比例
    // 阈值（CI 字体 fallback 环境差异会把阈值误判成渲染缺陷，#342 教训）
    const h1Before = await browser.execute(() => {
      const h = document.querySelector(".markdown-body h1");
      return h ? h.getBoundingClientRect().height : null;
    });
    expect(h1Before).not.toBeNull();

    await pressShortcut(browser, "=", { ctrl: true });
    await browser.waitUntil(async () => (await getZoom(browser)) === 110, {
      timeout: 5000,
      timeoutMsg: "分屏下 Ctrl+= 后 zoom 未到 110（#412 出口未开）",
    });

    // 状态变了，渲染也要真的变（#412 验收：不只是改状态）
    const h1After = await browser.execute(() => {
      const h = document.querySelector(".markdown-body h1");
      return h ? h.getBoundingClientRect().height : null;
    });
    expect(h1After).not.toBeNull();
    expect(h1After!).toBeGreaterThan(h1Before!);
    expect(await readText(browser, ".status-zoom-chip", /110%/)).toContain("110%");

    await pressShortcut(browser, "0", { ctrl: true });
    await browser.waitUntil(async () => (await getZoom(browser)) === 100, {
      timeout: 5000,
      timeoutMsg: "分屏下 Ctrl+0 后 zoom 未复位到 100",
    });

    // Ctrl+- 缩小（#412 验收 1：三个快捷键在分屏下逐一真实过渡）
    await pressShortcut(browser, "-", { ctrl: true });
    await browser.waitUntil(async () => (await getZoom(browser)) === 90, {
      timeout: 5000,
      timeoutMsg: "分屏下 Ctrl+- 后 zoom 未到 90（#412 出口未开）",
    });
    await pressShortcut(browser, "0", { ctrl: true });
    await browser.waitUntil(async () => (await getZoom(browser)) === 100, {
      timeout: 5000,
      timeoutMsg: "分屏下 Ctrl+- 后 Ctrl+0 未复位到 100",
    });
  });

  it("源码模式（无预览区）下缩放快捷键不生效（#412）", async () => {
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\intro.md`);
    // Ctrl+Shift+1 切源码模式（合成 keydown 按 SHIFT_BASE_KEYS 反查，e.key === "!"）
    await pressShortcut(browser, "!", { ctrl: true, shift: true });
    await browser.waitUntil(
      async () => (await browser.$(".editor-pane.mode-source")).isExisting(),
      { timeout: 10000 }
    );

    // 无预览区模式不生效：状态不变（zoomAppliesTo 门控 no-op）。
    // 事件链路本身已由上一用例（分屏生效）证明可达，此处不变即为门控生效。
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
