/**
 * 拖拽打开 E2E（issue #92）
 *
 * 验证 Tauri 原生 drag-drop 事件驱动「拖入文件开标签 / 拖入目录设工作区 / 缺失路径静默忽略」，
 * 以及拖拽经过窗口时的遮罩提示。
 *
 * 驱动方式（已实测，结论见下）：
 *   真实场景里由 WebView2 从 OS 拖放产生 `tauri://drag-enter|over|drop|leave` 事件，
 *   e2e 无法真的从桌面拖文件进窗口，于是改用 Tauri 事件插件直接派发同名事件：
 *     window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
 *       event: "tauri://drag-drop",
 *       payload: { paths: [...], position: { x, y } },
 *     })
 *
 * **实测结论：能被 `getCurrentWebviewWindow().onDragDropEvent` 收到。** 依据（读 tauri 2.11.6
 * 源码确认，且本 spec 的运行即实证）：`onDragDropEvent` 内部对每个 `tauri://drag-*` 各注册一个
 * JS 监听；而 JS 事件派发走 `Listeners::emit_js`（`emit` 传入的 filter 为 None），
 * `match_any_or_filter` 在 filter 为 None 时恒真 —— 即「emit（Any target）」会命中所有 JS 监听、
 * 不按 target 过滤。这与既有的 `emitMenuEvent`（`plugin:event|emit` 触发 App.vue 的 menu-event
 * 监听）完全同一机制。因此 **不需要在 App.vue 增加 test hook**。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace, defaultFixtureFiles } from "../helpers/fixtures";
import {
  waitForPinia,
  closeAllTabs,
  closeWorkspace,
  dismissAllDialogs,
  resetPersistenceSettings,
} from "../helpers/store";
import { readText, waitForAbsent, waitForInBrowser, waitForPresent } from "../helpers/wait";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

let browser: Browser;
let wsPath: string;

type DragEventName =
  | "tauri://drag-enter"
  | "tauri://drag-over"
  | "tauri://drag-drop"
  | "tauri://drag-leave";

/** 通过 Tauri 事件插件派发一个原生 drag-drop 事件（见文件头注释） */
async function emitDragEvent(
  b: Browser,
  event: DragEventName,
  payload: Record<string, unknown>
): Promise<void> {
  const res = (await b.executeAsync(
    (evt: string, p: Record<string, unknown>, done: (r: unknown) => void) => {
      // @ts-ignore 应用内部 WebView，仅应用代码可访问
      window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: evt, payload: p }).then(
        () => done({ ok: true }),
        (err: unknown) => done({ error: String(err) })
      );
    },
    event,
    payload
  )) as { ok?: boolean; error?: string };
  if (res?.error) {
    throw new Error(`派发 ${event} 失败: ${res.error}`);
  }
}

/** 派发一次 drag-drop（模拟用户把 paths 拖到窗口上松开） */
async function dropPaths(b: Browser, paths: string[]): Promise<void> {
  await emitDragEvent(b, "tauri://drag-drop", {
    paths,
    position: { x: 200, y: 200 },
  });
}

/** 当前窗口的标签路径列表 */
async function tabPaths(): Promise<string[]> {
  return browser.execute(() => {
    // @ts-ignore
    const pinia = window.__pinia__;
    return (pinia._s.get("tabs")?.tabs ?? []).map((t: { path: string | null }) => t.path);
  });
}

/** 当前窗口的工作区路径 */
async function workspacePath(): Promise<string | null> {
  return browser.execute(() => {
    // @ts-ignore
    const pinia = window.__pinia__;
    return pinia._s.get("workspace")?.workspacePath ?? null;
  });
}

/** 路径归一后再比较：tabs 里存的可能是正斜杠形式，比较时统一大小写与分隔符 */
function normalize(paths: (string | null)[]): string[] {
  return paths.map((p) => (p ?? "").toLowerCase().replace(/\\/g, "/"));
}

describe("拖拽打开（原生 drag-drop）", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
    // 关键：`__pinia__` 暴露不代表 onMounted 跑完（drag-drop 监听在 onMounted 第 7.5 步注册）。
    // App.vue 在 onMounted **结尾**才赋值 `__setSidebarView__`，等它出现即保证监听已就绪，
    // 否则 session 刚建好就派发事件可能落在监听注册之前而丢失。
    await waitForInBrowser(
      browser,
      () => typeof (window as any).__setSidebarView__ === "function",
      [],
      { timeout: 20000, message: "应用就绪（drag-drop 监听已注册）" }
    );
  }, 60000);

  afterAll(async () => {
    if (!browser) return;
    await closeSession(browser);
  });

  beforeEach(async () => {
    await dismissAllDialogs(browser);
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
    // 复位拖拽遮罩状态（前一用例可能停在 enter 态）
    await emitDragEvent(browser, "tauri://drag-leave", {}).catch(() => {});
    wsPath = resetWorkspace(defaultFixtureFiles());
  });

  it("拖入单个 .md 文件 → 当前窗口打开为标签", async () => {
    const target = join(wsPath, "intro.md");
    await dropPaths(browser, [target]);

    const opened = await waitForInBrowser(
      browser,
      (p: string) => {
        // @ts-ignore
        const tabs = window.__pinia__._s.get("tabs");
        return (tabs.tabs ?? []).some((t: { path: string | null }) => t.path === p);
      },
      [target],
      { timeout: 15000, message: "拖入的文件被打开为标签" }
    );
    expect(opened).toBe(true);
    expect(await workspacePath()).toBeNull();
  });

  it("拖入单个目录 → 当前窗口打开为该目录工作区", async () => {
    await dropPaths(browser, [wsPath]);

    const ok = await waitForInBrowser(
      browser,
      (p: string) => {
        // @ts-ignore
        return window.__pinia__._s.get("workspace")?.workspacePath === p;
      },
      [wsPath],
      { timeout: 15000, message: "拖入的目录成为工作区" }
    );
    expect(ok).toBe(true);
    // 文件树随之出现
    await waitForPresent(browser, ".file-tree", 10000);
    expect(await tabPaths()).toEqual([]);
  });

  it("拖入不存在的路径 → 静默忽略，不打开标签也不设工作区", async () => {
    await dropPaths(browser, [join(wsPath, "no-such-file.md")]);
    // 负向断言：留一段静默期让异步处理落定（正常处理很快）
    await browser.pause(1500);
    expect(await tabPaths()).toEqual([]);
    expect(await workspacePath()).toBeNull();
    // 应用仍存活
    expect(await browser.execute(() => !!window.__pinia__)).toBe(true);
  });

  it("拖入图片 → 本 PR 不处理（不打开标签、不设工作区；图片链路见 #288）", async () => {
    const img = join(wsPath, "pic.png");
    writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await dropPaths(browser, [img]);
    await browser.pause(1500);
    expect(await tabPaths()).toEqual([]);
    expect(await workspacePath()).toBeNull();
  });

  it("拖入多个文件 → 按拖入顺序逐个打开为标签", async () => {
    const files = [
      join(wsPath, "intro.md"),
      join(wsPath, "notes.md"),
      join(wsPath, "sub", "deep.md"),
    ];
    await dropPaths(browser, files);

    await waitForInBrowser(
      browser,
      (want: number) => {
        // @ts-ignore
        return (window.__pinia__._s.get("tabs")?.tabs ?? []).length === want;
      },
      [files.length],
      { timeout: 15000, message: "拖入的多个文件都被打开为标签" }
    );
    expect(normalize(await tabPaths())).toEqual(normalize(files));
    expect(await workspacePath()).toBeNull();
  });

  it("混合拖入：只打开受支持的文件，不支持的类型忽略", async () => {
    const md = join(wsPath, "intro.md");
    const zip = join(wsPath, "archive.zip");
    writeFileSync(zip, Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    await dropPaths(browser, [md, zip]);

    await waitForInBrowser(
      browser,
      (want: number) => {
        // @ts-ignore
        return (window.__pinia__._s.get("tabs")?.tabs ?? []).length === want;
      },
      [1],
      { timeout: 15000, message: "只有受支持的那个文件被打开" }
    );
    // 负向断言：留一段静默期，确认 zip 没有被打开
    await browser.pause(1200);
    const opened = await tabPaths();
    expect(normalize(opened)).toEqual(normalize([md]));
    expect(normalize(opened)).not.toContain(normalize([zip])[0]);
  });

  it("拖拽经过窗口时显示遮罩，离开后消失", async () => {
    await emitDragEvent(browser, "tauri://drag-enter", {
      paths: [join(wsPath, "intro.md")],
      position: { x: 200, y: 200 },
    });
    await waitForPresent(browser, ".murasaki-drop-overlay", 5000);
    // 提示文案非空（存在 + 内容断言即可，浮层不判几何/透明度）
    expect((await readText(browser, ".murasaki-drop-overlay-title")).length).toBeGreaterThan(0);

    await emitDragEvent(browser, "tauri://drag-leave", {});
    await waitForAbsent(browser, ".murasaki-drop-overlay", 5000);
  });
});
