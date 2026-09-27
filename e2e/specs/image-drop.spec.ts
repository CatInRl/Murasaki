/**
 * 外部拖入图片 E2E（issue #288）
 *
 * 验证「从系统拖入图片」改由 Tauri 原生 drag-drop 事件驱动后：
 * - file 模式 → 复制到工作区图片目录并插入**相对当前 md 文件**的引用，且只插入一次；
 * - base64 模式 → 内嵌 `data:image/...;base64,...`，且只插入一次；
 * - 按住 Alt → 临时取反（配置 file 时改内嵌）；
 * - 一次拖入多张 → 按拖入顺序都插入。
 *
 * 驱动方式与 drag-drop.spec.ts 一致（已实测可被前端 `onDragDropEvent` 收到）：
 *   window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
 *     event: "tauri://drag-drop",
 *     payload: { paths, position: { x, y } },
 *   })
 * 其中 `position` 是构造值（e2e 无法真的从桌面拖文件），换算不出时前端会回退光标 ——
 * 断言只依赖「引用出现且各出现一次」，不依赖具体插入位置。
 *
 * 遵守 AGENTS.md「e2e 的八个坑」：等 UI 用 `waitForPresent` / `waitForInBrowser`，
 * 判「视图就绪」用存在性（`.cm-content` 存在即编辑器已挂载），不用元素等待命令 /
 * `isDisplayed()` / `getText()`。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace, defaultFixtureFiles } from "../helpers/fixtures";
import {
  waitForPinia,
  openWorkspace,
  openFileInTab,
  closeAllTabs,
  closeWorkspace,
  dismissAllDialogs,
  resetPersistenceSettings,
} from "../helpers/store";
import { waitForInBrowser, waitForPresent } from "../helpers/wait";
import { writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

let browser: Browser;
let wsPath: string;

/** 设置图片插入方式 + 默认图片目录（保证用例不受前序 spec 残留设置影响） */
async function setImageSettings(b: Browser, mode: "file" | "base64"): Promise<void> {
  await b.executeAsync(
    (m: string, done: (r: unknown) => void) => {
      // @ts-ignore
      const persistence = window.__pinia__._s.get("persistence");
      Promise.resolve(
        persistence.updateSettings({ imageInsertMode: m, defaultImageDir: "assets/images" })
      ).then(
        () => done(null),
        (err: unknown) => done(String(err))
      );
    },
    mode
  );
  await b.pause(200);
}

/** 派发一次原生 drag-drop（模拟用户把 paths 拖到窗口上松开） */
async function dropImagePaths(
  b: Browser,
  paths: string[],
  position = { x: 300, y: 300 }
): Promise<void> {
  const res = (await b.executeAsync(
    (ps: string[], pos: { x: number; y: number }, done: (r: unknown) => void) => {
      // @ts-ignore 应用内部 WebView，仅应用代码可访问
      window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "tauri://drag-drop",
        payload: { paths: ps, position: pos },
      }).then(
        () => done({ ok: true }),
        (err: unknown) => done({ error: String(err) })
      );
    },
    paths,
    position
  )) as { ok?: boolean; error?: string };
  if (res?.error) throw new Error(`派发 tauri://drag-drop 失败: ${res.error}`);
}

/** 读 CodeMirror 当前文档内容（从 view 读，不是从 store 读） */
async function editorDoc(b: Browser): Promise<string> {
  return b.execute(() => {
    // @ts-ignore
    const view = window.__editorRef__?.getView?.();
    return view ? view.state.doc.toString() : "";
  });
}

/** 计数子串出现次数 */
function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** 打开工作区 + 打开 intro.md 并等编辑器挂载 */
async function openIntro(): Promise<void> {
  await openWorkspace(browser, wsPath);
  await openFileInTab(browser, join(wsPath, "intro.md"));
  await waitForPresent(browser, ".cm-content", 15000);
}

/** 在工作区里写一张源图片（内容固定，便于 base64 断言） */
function writeSourceImage(name: string, bytes: number[]): string {
  const p = join(wsPath, name);
  writeFileSync(p, Buffer.from(bytes));
  return p;
}

describe("外部拖入图片（Tauri 原生 drag-drop，issue #288）", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
    // 等应用就绪：onMounted 结尾才赋值 __setSidebarView__，等它出现即保证拖放监听已注册
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
    wsPath = resetWorkspace(defaultFixtureFiles());
  });

  it("file 模式 → 插入相对路径引用（复制到工作区图片目录），且只插入一次", async () => {
    await setImageSettings(browser, "file");
    await openIntro();

    const img = writeSourceImage("source.png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    await dropImagePaths(browser, [img], { x: 300, y: 300 });

    // 等引用出现：相对路径（非 data URI）
    await waitForInBrowser(
      browser,
      () => {
        // @ts-ignore
        const view = window.__editorRef__?.getView?.();
        const doc = view ? view.state.doc.toString() : "";
        return /!\[\]\(assets\/images\/[^)]+\.png\)/.test(doc);
      },
      [],
      { timeout: 15000, message: "file 模式拖入图片后编辑器出现相对路径引用" }
    );

    // 「只插入一次」：留一段静默期后重新计数（防 HTML5 drop + Tauri 双入口）
    await browser.pause(1000);
    const doc = await editorDoc(browser);
    expect(countOf(doc, "](assets/images/")).toBe(1);
    expect(doc).not.toContain("data:image/");

    // 落盘文件确实存在
    const match = doc.match(/!\[\]\((assets\/images\/[^)]+\.png)\)/);
    expect(match).not.toBeNull();
    expect(existsSync(resolve(wsPath, match![1]))).toBe(true);
  }, 60000);

  it("base64 模式 → 插入内嵌 data URI，且只插入一次", async () => {
    await setImageSettings(browser, "base64");
    await openIntro();

    const img = writeSourceImage("inline.png", [1, 2, 3]);
    await dropImagePaths(browser, [img], { x: 300, y: 300 });

    await waitForInBrowser(
      browser,
      () => {
        // @ts-ignore
        const view = window.__editorRef__?.getView?.();
        const doc = view ? view.state.doc.toString() : "";
        return /!\[\]\(data:image\/png;base64,/.test(doc);
      },
      [],
      { timeout: 15000, message: "base64 模式拖入图片后编辑器出现内嵌引用" }
    );

    await browser.pause(1000);
    const doc = await editorDoc(browser);
    expect(countOf(doc, "](data:image/png;base64,")).toBe(1);
    expect(doc).not.toContain("assets/images/");
  }, 60000);

  it("按住 Alt → 临时取反（配置 file 时改为内嵌 Base64）", async () => {
    await setImageSettings(browser, "file");
    await openIntro();

    const img = writeSourceImage("alt.png", [9, 9, 9]);
    // 按下 Alt（ClipboardEvent / drag-drop payload 都不带修饰键，前端自己跟踪键盘状态）
    await browser.execute(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt" }));
    });
    try {
      await dropImagePaths(browser, [img], { x: 300, y: 300 });
      await waitForInBrowser(
        browser,
        () => {
          // @ts-ignore
          const view = window.__editorRef__?.getView?.();
          const doc = view ? view.state.doc.toString() : "";
          return doc.includes("data:image/png;base64,");
        },
        [],
        { timeout: 15000, message: "按住 Alt 拖入图片后出现内嵌引用（取反生效）" }
      );
      await browser.pause(800);
      const doc = await editorDoc(browser);
      expect(countOf(doc, "](data:image/png;base64,")).toBe(1);
      expect(doc).not.toContain("assets/images/");
    } finally {
      // 必放开 Alt，避免污染后续用例
      await browser.execute(() => {
        window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));
      });
    }
  }, 60000);

  it("一次拖入多张 → 按拖入顺序各插入一次", async () => {
    await setImageSettings(browser, "base64");
    await openIntro();

    // 不同字节 → 不同 base64，可用它在文档里的先后顺序验证「按顺序插入」
    const first = writeSourceImage("first.png", [1]); // base64: AQ==
    const second = writeSourceImage("second.png", [2]); // base64: Ag==
    await dropImagePaths(browser, [first, second], { x: 300, y: 300 });

    await waitForInBrowser(
      browser,
      () => {
        // @ts-ignore
        const view = window.__editorRef__?.getView?.();
        const doc = view ? view.state.doc.toString() : "";
        return doc.includes("base64,AQ==") && doc.includes("base64,Ag==");
      },
      [],
      { timeout: 15000, message: "两张图片的内嵌引用都出现" }
    );

    await browser.pause(800);
    const doc = await editorDoc(browser);
    expect(countOf(doc, "base64,AQ==")).toBe(1);
    expect(countOf(doc, "base64,Ag==")).toBe(1);
    // 顺序：第一张在前
    expect(doc.indexOf("base64,AQ==")).toBeLessThan(doc.indexOf("base64,Ag=="));
  }, 60000);
});
