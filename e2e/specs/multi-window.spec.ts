/**
 * 多窗口多工作区 E2E 测试（0.9.0 / #194）
 *
 * 验证：
 * - `open_path_in_new_window` 打开目录 → 新增一个窗口，返回新窗口 label
 * - 新窗口是独立前端会话（有自己的 Pinia），且不恢复上次工作区/标签
 * - 同一目录已在某窗口打开 → 聚焦既有窗口，不重复开窗
 * - 新窗口可用 `close_window` 单独关闭，主窗口不受影响
 *
 * 注意：E2E 下 WebView2 由 msedgedriver 驱动，第二窗口的加载比 dev 模式更慢，
 * 因此这里用较宽松的轮询超时。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace, defaultFixtureFiles } from "../helpers/fixtures";
import {
  waitForPinia,
  waitForPiniaInCurrentWindow,
  closeAllTabs,
  closeWorkspace,
  dismissAllDialogs,
  resetPersistenceSettings,
} from "../helpers/store";

let browser: Browser;
let wsPath: string;
let mainHandle: string;

/** 调用 Rust 命令在新窗口打开路径，返回新窗口 label */
async function openInNewWindow(path: string): Promise<string> {
  return browser.executeAsync(
    (p: string, done: (res: unknown) => void) => {
      window.__TAURI_INTERNALS__
        .invoke("open_path_in_new_window", { path: p })
        .then((label: string) => done({ label }))
        .catch((err: unknown) => done({ error: String(err) }));
    },
    path
  ).then((r: any) => {
    if (r?.error) throw new Error(`open_path_in_new_window failed: ${r.error}`);
    return r.label as string;
  });
}

/** 当前 WebView 的窗口 label（兼容多种 metadata 形态） */
async function currentLabel(): Promise<string | null> {
  return browser.execute(() => {
    const md = window.__TAURI_INTERNALS__?.metadata ?? {};
    return (
      md.currentWindow?.label ??
      md.currentWebviewWindow?.label ??
      md.currentWebview?.label ??
      null
    );
  });
}

/** 读取当前窗口的工作区路径与标签数量 */
async function currentSession(): Promise<{
  workspacePath: string | null;
  tabCount: number;
}> {
  return browser.execute(() => {
    const pinia = window.__pinia__;
    return {
      workspacePath: pinia._s.get("workspace")?.workspacePath ?? null,
      tabCount: (pinia._s.get("tabs")?.tabs ?? []).length,
    };
  });
}

/** 关掉除主窗口外的所有窗口，并切回主窗口 */
async function closeExtraWindows(): Promise<void> {
  const handles = await browser.getWindowHandles().catch(() => [] as string[]);
  for (const handle of handles) {
    if (handle === mainHandle) continue;
    try {
      await browser.switchToWindow(handle);
      await browser.execute(() => {
        try {
          window.__TAURI_INTERNALS__.invoke("close_window");
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* ignore */
    }
    await browser.pause(800);
  }
  if (mainHandle) {
    try {
      await browser.switchToWindow(mainHandle);
    } catch {
      /* ignore */
    }
  }
}

describe("多窗口多工作区", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
    mainHandle = (await browser.getWindowHandle()) ?? "";
    expect(mainHandle).not.toBe("");
  }, 60000);

  afterAll(async () => {
    if (!browser) return;
    try {
      await closeExtraWindows();
    } catch {
      /* ignore */
    }
    await closeSession(browser);
  });

  beforeEach(async () => {
    await closeExtraWindows();
    await dismissAllDialogs(browser);
    await resetPersistenceSettings(browser);
    try {
      await closeAllTabs(browser);
    } catch {
      /* ignore */
    }
    // 必须关掉当前工作区：应用启动时会按 lastWorkspacePath 恢复上次工作区
    // （reopenLastWorkspace 默认为 true），此时 main 窗口已持有本次要打开的目录，
    // open_path_in_new_window 就会走「同目录聚焦」分支返回 'main'，断言不到新窗口。
    // 本地因残留 settings 里恰好 reopenLastWorkspace=false 而掩盖了这一点，CI 上
    // （全新 appdata、按默认值启动）必现。
    // closeWorkspace 会把 workspacePath 置 null，useAppLifecycle 随即同步
    // set_window_workspace(null)，Rust 侧的窗口注册表也随之清空。
    try {
      await closeWorkspace(browser);
    } catch {
      /* ignore */
    }
    wsPath = resetWorkspace(defaultFixtureFiles());
  });

  it("打开文件夹路径 → 新增一个窗口，且新窗口是独立空会话", async () => {
    const before = await browser.getWindowHandles();

    const label = await openInNewWindow(wsPath);
    expect(typeof label).toBe("string");
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toBe("main");

    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length > before.length,
      { timeout: 30000, interval: 500 }
    );

    // 切到新窗口并等待其前端就绪
    const handles = await browser.getWindowHandles();
    const newHandle = handles.find((h) => !before.includes(h));
    expect(newHandle).toBeDefined();
    await browser.switchToWindow(newHandle!);
    // 必须用「不切句柄」的等待：waitForPinia 会遍历句柄并停回主窗口，
    // 导致下面的 label / session 断言读的是主窗口（见 helpers/store.ts）
    await waitForPiniaInCurrentWindow(browser, 30000);

    // 新窗口是独立前端会话：不恢复上次标签（外部入口不恢复会话）
    const session = await currentSession();
    expect(session.tabCount).toBe(0);

    // 窗口 label 与返回值一致
    expect(await currentLabel()).toBe(label);

    await closeExtraWindows();
  });

  it("同一目录再次打开 → 聚焦已有窗口，不重复开窗", async () => {
    await openInNewWindow(wsPath);
    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length === 2,
      { timeout: 30000, interval: 500 }
    );
    const afterFirst = await browser.getWindowHandles();
    const wsWindow = afterFirst.find((h) => h !== mainHandle)!;
    await browser.switchToWindow(wsWindow);
    await waitForPiniaInCurrentWindow(browser, 30000);

    // 第二次打开同一目录（从该窗口发起）
    const label2 = await openInNewWindow(wsPath);
    expect(label2).toBe(await currentLabel());

    // 等待一段时间，窗口数不应增加
    await browser.pause(3000);
    expect((await browser.getWindowHandles()).length).toBe(afterFirst.length);

    await closeExtraWindows();
  });

  it("close_window 只关闭本窗口，主窗口仍在", async () => {
    await openInNewWindow(wsPath);
    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length === 2,
      { timeout: 30000, interval: 500 }
    );

    const wsWindow = (await browser.getWindowHandles()).find(
      (h) => h !== mainHandle
    )!;
    await browser.switchToWindow(wsWindow);
    await waitForPiniaInCurrentWindow(browser, 30000);

    await browser.execute(() => {
      try {
        window.__TAURI_INTERNALS__.invoke("close_window");
      } catch {
        /* ignore */
      }
    });

    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length === 1,
      { timeout: 15000, interval: 500 }
    );

    // 切回主窗口，__pinia__ 仍可用（主窗口未被连带退出）
    await browser.switchToWindow(mainHandle);
    const alive = await browser.execute(() => !!window.__pinia__);
    expect(alive).toBe(true);
  });
});
