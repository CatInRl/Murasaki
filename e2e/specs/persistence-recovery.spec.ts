/**
 * 持久化恢复 E2E 测试（覆盖 H7-H8）
 *
 * 验证：
 * - H7: tabs 状态持久化 + restore() 恢复 tab 列表 + 激活索引
 * - H8: 草稿恢复：关闭未保存 tab 时写入草稿，下次打开自动恢复
 *
 * 由于真正重启 murasaki 进程成本太高，通过 store API 模拟：
 * - tabs.persist() + clearAll() + restore() 模拟重启
 * - save_draft + openFile 验证草稿恢复
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
  getActiveContent,
} from "../helpers/store";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

let browser: Browser;
let wsPath: string;

describe("持久化恢复", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  beforeEach(async () => {
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
    await dismissAllDialogs(browser);
  });

  // ===== H7: tabs 持久化 + 恢复 =====

  it("tabs.persist + restore 恢复 tab 列表和激活索引", async () => {
    const introPath = resolve(wsPath, "intro.md").replace(/\\/g, "/");
    const notesPath = resolve(wsPath, "notes.md").replace(/\\/g, "/");

    // 打开两个文件
    await openFileInTab(browser, introPath);
    await openFileInTab(browser, notesPath);
    await browser.pause(300);

    // 切换激活到 intro.md（activeIndex=0）
    await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      const intro = tabs.tabs.find((t: any) => t.path?.endsWith("intro.md"));
      if (intro) tabs.switchTo(intro.id);
    });
    await browser.pause(200);

    // 持久化当前状态
    await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const tabs = pinia._s.get("tabs");
      Promise.resolve(tabs.persist())
        .then(() => done(null))
        .catch((err: unknown) => done(err ? String(err) : null));
    });

    // 清空 tabs（模拟应用关闭）
    await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      tabs.clearAll();
    });
    await browser.pause(200);

    // 验证 tabs 已清空
    const empty = await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      return { count: tabs.tabs.length, activeId: tabs.activeTabId };
    });
    expect(empty.count).toBe(0);

    // 调用 restore 模拟重启恢复
    const restoreErr = await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const tabs = pinia._s.get("tabs");
      Promise.resolve(tabs.restore())
        .then(() => done(null))
        .catch((err: unknown) => done(err ? String(err) : null));
    });
    if (restoreErr) {
      throw new Error(`restore failed: ${restoreErr}`);
    }

    // 等待 restore 完成（openFile 是异步的）
    await browser.waitUntil(
      async () => {
        const count = await browser.execute(() => {
          // @ts-ignore
          const tabs = window.__pinia__._s.get("tabs");
          return tabs.tabs.length;
        });
        return count >= 2;
      },
      {
        timeout: 20000,
        interval: 200,
        timeoutMsg: "restore 未在 20s 内恢复 >=2 个 tab（可能 openFile 失败或 tabs.json 未写入）",
      }
    );

    // 验证恢复的 tab 列表
    const restored = await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      return {
        tabs: tabs.tabs.map((t: any) => ({
          path: t.path,
          title: t.path ? t.path.split(/[\\/]/).pop() : "未命名",
        })),
        activeTabId: tabs.activeTabId,
        activePath: tabs.activeTab?.path,
      };
    });

    expect(restored.tabs.length).toBe(2);
    const paths = restored.tabs.map((t: any) => t.path);
    expect(paths).toEqual(expect.arrayContaining([introPath, notesPath]));

    // 激活的应是 intro.md（之前 switchTo 设置的）
    expect(restored.activePath).toBe(introPath);
  });

  // ===== H8: 草稿恢复 =====

  it("save_draft 后 openFile 恢复草稿内容并标记 isDirty", async () => {
    const introPath = resolve(wsPath, "intro.md").replace(/\\/g, "/");

    // 先打开文件获取 mtime
    await openFileInTab(browser, introPath);
    await browser.pause(300);

    const mtime = await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      return tabs.activeTab?.lastMtime;
    });

    // 关闭 tab
    await closeAllTabs(browser);
    await browser.pause(200);

    // 通过 Tauri 命令写入草稿（模拟关闭未保存 tab 时保存草稿）
    const draftContent = "# 这是未保存的草稿内容\n\n不应丢失。\n";
    const draftResult = await browser.executeAsync(
      (path: string, content: string, mt: number, done: (res: unknown) => void) => {
        // @ts-ignore
        window.__TAURI_INTERNALS__.invoke("save_draft", {
          path,
          content,
          knownMtime: mt,
        })
          .then(() => done({ ok: true }))
          .catch((err: unknown) => done({ ok: false, error: err ? String(err) : null }));
      },
      introPath,
      draftContent,
      mtime ?? 0
    );
    expect(draftResult as any).toMatchObject({ ok: true });

    // 验证草稿存在
    const exists = await browser.executeAsync((path: string, done: (res: unknown) => void) => {
      // @ts-ignore
      window.__TAURI_INTERNALS__.invoke("draft_exists", { path })
        .then((r: boolean) => done({ ok: true, exists: r }))
        .catch((err: unknown) => done({ ok: false, error: err ? String(err) : null }));
    }, introPath);
    expect((exists as any).exists).toBe(true);

    // 再次打开文件：应触发草稿恢复
    await openFileInTab(browser, introPath);
    await browser.pause(500);

    // 验证内容为草稿内容
    const restoredContent = await getActiveContent(browser);
    expect(restoredContent).toBe(draftContent);

    // 验证 isDirty = true（草稿内容与磁盘不一致）
    const isDirty = await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      return tabs.activeTab?.isDirty;
    });
    expect(isDirty).toBe(true);

    // 清理草稿
    await browser.executeAsync((path: string, done: (res: unknown) => void) => {
      // @ts-ignore
      window.__TAURI_INTERNALS__.invoke("delete_draft", { path })
        .then(() => done(null))
        .catch((err: unknown) => done(err ? String(err) : null));
    }, introPath);
  });

  it("草稿过期：磁盘被外部修改后草稿应被丢弃", async () => {
    const introPath = resolve(wsPath, "intro.md");
    const path = introPath.replace(/\\/g, "/");

    await openFileInTab(browser, path);
    await browser.pause(300);

    const originalMtime = await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      return tabs.activeTab?.lastMtime;
    });

    await closeAllTabs(browser);
    await browser.pause(200);

    // 写入草稿（knownMtime = originalMtime）
    const draftContent = "# 草稿内容\n";
    await browser.executeAsync(
      (p: string, c: string, mt: number, done: (res: unknown) => void) => {
        // @ts-ignore
        window.__TAURI_INTERNALS__.invoke("save_draft", { path: p, content: c, knownMtime: mt })
          .then(() => done(null))
          .catch((err: unknown) => done(err ? String(err) : null));
      },
      path,
      draftContent,
      originalMtime ?? 0
    );

    // 外部修改文件（mtime 会变化）
    const newDiskContent = "# 磁盘新版本 - 草稿应被丢弃\n";
    writeFileSync(introPath, newDiskContent, "utf-8");

    // 等待 mtime 变化（确保 mtime 不同）
    await new Promise((r) => setTimeout(r, 1100));

    // 再次打开文件：草稿应被丢弃（mtime 不匹配），使用磁盘内容
    await openFileInTab(browser, path);
    await browser.pause(500);

    const restoredContent = await getActiveContent(browser);
    expect(restoredContent).toBe(newDiskContent);

    // isDirty 应为 false（磁盘内容即当前内容）
    const isDirty = await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      return tabs.activeTab?.isDirty;
    });
    expect(isDirty).toBe(false);

    // 草稿应已被清理
    const draftExists = await browser.executeAsync((p: string, done: (res: unknown) => void) => {
      // @ts-ignore
      window.__TAURI_INTERNALS__.invoke("draft_exists", { path: p })
        .then((r: boolean) => done({ exists: r }))
        .catch((err: unknown) => done({ error: err ? String(err) : null }));
    }, path);
    expect((draftExists as any).exists).toBe(false);
  });

  it("未保存的新文件 tab（无 path）持久化后恢复", async () => {
    // 创建未命名 tab 并写入内容
    await browser.execute(() => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const tabs = pinia._s.get("tabs");
      tabs.newTab("# 未保存的新内容\n");
    });
    await browser.pause(200);

    // 持久化
    await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const tabs = pinia._s.get("tabs");
      Promise.resolve(tabs.persist())
        .then(() => done(null))
        .catch((err: unknown) => done(err ? String(err) : null));
    });

    // 清空 + 恢复
    await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      tabs.clearAll();
    });
    await browser.pause(200);

    await browser.executeAsync((done: (res: unknown) => void) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const tabs = pinia._s.get("tabs");
      Promise.resolve(tabs.restore())
        .then(() => done(null))
        .catch((err: unknown) => done(err ? String(err) : null));
    });

    await browser.waitUntil(
      async () => {
        const count = await browser.execute(() => {
          // @ts-ignore
          const tabs = window.__pinia__._s.get("tabs");
          return tabs.tabs.length;
        });
        return count >= 1;
      },
      {
        timeout: 20000,
        interval: 200,
        timeoutMsg: "restore 未在 20s 内恢复未命名 tab（可能 tabs.json 未写入或 newTab 失败）",
      }
    );

    const restored = await browser.execute(() => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      return {
        path: tabs.activeTab?.path,
        content: tabs.activeTab?.content,
        isDirty: tabs.activeTab?.isDirty,
      };
    });

    expect(restored.path).toBeNull();
    expect(restored.content).toBe("# 未保存的新内容\n");
    expect(restored.isDirty).toBe(true);
  });
});
