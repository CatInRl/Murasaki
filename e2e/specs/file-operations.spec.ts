/**
 * 文件树右键菜单 + 文件操作安全 E2E 测试（覆盖 H1-H3）
 *
 * 验证：
 * - H1: 文件树右键菜单显示正确的菜单项（文件/文件夹差异）
 * - H2: 新建文件 / 新建文件夹 / 重命名 / 删除 / 剪切 / 复制 / 粘贴 操作闭环
 * - H3: 冲突处理对话框（覆盖 / 重命名 / 取消）正确触发
 *
 * 由于 TreeNode.vue 通过 useContextMenuStore().show() 触发菜单，
 * 测试通过 store 直接调用 fileOps API + 验证 UI 渲染相结合。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace, defaultFixtureFiles } from "../helpers/fixtures";
import {
  openWorkspace,
  closeWorkspace,
  closeAllTabs,
  waitForPinia,
  dismissAllDialogs,
  resetPersistenceSettings,
  callStoreAction,
} from "../helpers/store";
import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

let browser: Browser;
let wsPath: string;

describe("文件树右键菜单 + 文件操作安全", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  beforeEach(async () => {
    await resetPersistenceSettings(browser);
    // 先关闭工作区（停止文件监听），再重置磁盘，避免 EPERM 和残留文件
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
    await browser.pause(200); // 等待 file watcher 释放句柄
    wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    // 等待文件树就绪
    await (await browser.$(".file-tree")).waitForExist({ timeout: 10000 });
    await dismissAllDialogs(browser);
  });

  // ===== H1: 右键菜单结构验证 =====

  it("右键文件节点显示文件专属菜单项（打开/重命名/剪切/复制/删除）", async () => {
    // 通过 contextMenu store 模拟右键点击 intro.md 节点
    // TreeNode.vue 的 onContextMenu 会调用 contextMenu.show(e, buildMenuItems())
    // 这里直接调用 fileOps + 验证菜单项结构
    await browser.execute(() => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const menu = pinia._s.get("contextMenu");
      menu.hide();
      // 模拟 contextmenu 事件
      const evt = new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 100,
        clientY: 100,
      });
      // 找到 intro.md 节点元素并派发事件
      const nodes = document.querySelectorAll(
        '.file-tree .tree-node .node-name'
      );
      const introNode = Array.from(nodes).find(
        (n) => n.textContent?.trim() === "intro.md"
      );
      if (introNode) {
        // TreeNode 的事件监听器挂在 .node-row 上
        const row = introNode.closest(".node-row");
        row?.dispatchEvent(evt);
      }
    });

    const menuEl = await browser.$(".murasaki-context-menu");
    await menuEl.waitForDisplayed({ timeout: 5000 });

    const items = await browser.$$(".murasaki-context-menu-item");
    const labels: string[] = [];
    for (const item of items) {
      const label = await item.$(".murasaki-context-menu-label");
      labels.push((await label.getText()).trim());
    }
    // 文件节点应有：打开 / 重命名 / 剪切 / 复制 / 复制路径 / 复制相对路径 / 删除 / 在文件资源管理器中显示
    expect(labels).toEqual(expect.arrayContaining(["打开", "重命名", "剪切", "复制", "删除"]));
    // 不应包含只有目录才有的 "新建文件" / "新建文件夹"
    expect(labels).not.toContain("新建文件");
    expect(labels).not.toContain("新建文件夹");
  });

  it("右键目录节点显示目录专属菜单项（新建文件/新建文件夹/粘贴）", async () => {
    await browser.execute(() => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const menu = pinia._s.get("contextMenu");
      menu.hide();
      const evt = new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 100,
        clientY: 100,
      });
      const nodes = document.querySelectorAll(
        '.file-tree .tree-node .node-name'
      );
      const subNode = Array.from(nodes).find(
        (n) => n.textContent?.trim() === "sub"
      );
      if (subNode) {
        const row = subNode.closest(".node-row");
        row?.dispatchEvent(evt);
      }
    });

    const menuEl = await browser.$(".murasaki-context-menu");
    await menuEl.waitForDisplayed({ timeout: 5000 });

    const items = await browser.$$(".murasaki-context-menu-item");
    const labels: string[] = [];
    for (const item of items) {
      const label = await item.$(".murasaki-context-menu-label");
      labels.push((await label.getText()).trim());
    }
    // 目录节点应有：新建文件 / 新建文件夹 / 重命名 / 剪切 / 复制 / 删除 / 在文件资源管理器中显示
    expect(labels).toEqual(
      expect.arrayContaining(["新建文件", "新建文件夹", "重命名", "剪切", "复制", "删除"])
    );
    // 不应包含只有文件才有的 "打开"
    expect(labels).not.toContain("打开");
  });

  // ===== H2: 文件操作闭环 =====

  it("新建文件：fileOps.createFile 后文件树刷新显示新文件", async () => {
    const node = await callStoreAction<any>(browser, "fileOps", "createFile", wsPath, "new-file.md");

    expect(node).toBeTruthy();
    expect(node.name).toBe("new-file.md");

    // 文件应真实存在于磁盘
    const filePath = resolve(wsPath, "new-file.md");
    expect(existsSync(filePath)).toBe(true);

    // 文件树应显示新文件
    const newNode = await browser.$(
      '//div[contains(@class, "file-tree")]//span[contains(@class, "node-name") and normalize-space()="new-file.md"]'
    );
    await newNode.waitForExist({ timeout: 5000 });
    expect(await newNode.isDisplayed()).toBe(true);
  });

  it("新建文件夹：fileOps.createDirectory 后文件树刷新显示新目录", async () => {
    const node = await callStoreAction<any>(browser, "fileOps", "createDirectory", wsPath, "new-folder");

    expect(node).toBeTruthy();
    expect(node.type).toBe("directory");

    const dirPath = resolve(wsPath, "new-folder");
    expect(existsSync(dirPath)).toBe(true);
    expect(statSync(dirPath).isDirectory()).toBe(true);

    // 文件树应显示新目录
    const newNode = await browser.$(
      '//div[contains(@class, "file-tree")]//span[contains(@class, "node-name") and normalize-space()="new-folder"]'
    );
    await newNode.waitForExist({ timeout: 5000 });
  });

  it("重命名：fileOps.renamePath 修改文件名并刷新文件树", async () => {
    const oldPath = resolve(wsPath, "intro.md");
    const newRelPath = "intro-renamed.md";
    expect(existsSync(oldPath)).toBe(true);

    const node = await callStoreAction<any>(
      browser, "fileOps", "renamePath",
      oldPath.replace(/\\/g, "/"),
      newRelPath
    );

    // 旧文件不存在，新文件存在
    expect(existsSync(oldPath)).toBe(false);
    const newPath = resolve(wsPath, newRelPath);
    expect(existsSync(newPath)).toBe(true);

    // 文件树显示新名称
    const newNode = await browser.$(
      '//div[contains(@class, "file-tree")]//span[contains(@class, "node-name") and normalize-space()="intro-renamed.md"]'
    );
    await newNode.waitForExist({ timeout: 5000 });
  });

  it("删除：fileOps.deletePath 移除文件并刷新文件树（走系统回收站）", async () => {
    const filePath = resolve(wsPath, "notes.md");
    expect(existsSync(filePath)).toBe(true);

    await callStoreAction(browser, "fileOps", "deletePath", filePath.replace(/\\/g, "/"));

    // 磁盘上文件已被删除
    expect(existsSync(filePath)).toBe(false);

    // 文件树中不应再有 notes.md
    await browser.pause(500);
    const notesNode = await browser.$(
      '//div[contains(@class, "file-tree")]//span[contains(@class, "node-name") and normalize-space()="notes.md"]'
    );
    expect(await notesNode.isExisting()).toBe(false);
  });

  it("剪切 + 粘贴：fileOps.cut + paste 移动文件到目标目录", async () => {
    const srcPath = resolve(wsPath, "intro.md");
    const targetDir = resolve(wsPath, "sub");
    expect(existsSync(srcPath)).toBe(true);

    // 剪切 intro.md（同步操作，无需等待）
    await browser.execute((path: string) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const fileOps = pinia._s.get("fileOps");
      fileOps.cut(path);
    }, srcPath.replace(/\\/g, "/"));

    // 粘贴到 sub/
    await callStoreAction(browser, "fileOps", "paste", targetDir.replace(/\\/g, "/"));

    // 源文件不存在，目标存在
    expect(existsSync(srcPath)).toBe(false);
    const movedPath = resolve(targetDir, "intro.md");
    expect(existsSync(movedPath)).toBe(true);

    // 文件树 sub/ 下应能找到 intro.md（需要展开 sub 目录）
    // 先展开 sub 目录
    await browser.execute(() => {
      const nodes = document.querySelectorAll('.file-tree .tree-node .node-name');
      const subNode = Array.from(nodes).find((n) => n.textContent?.trim() === "sub");
      if (subNode) {
        const row = subNode.closest(".node-row");
        row?.click();
        // 双击展开
        row?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      }
    });
    await browser.pause(500);
  });

  it("复制 + 粘贴：fileOps.copy + paste 在目标目录创建副本", async () => {
    const srcPath = resolve(wsPath, "notes.md");
    const targetDir = resolve(wsPath, "sub");
    const originalContent = readFileSync(srcPath, "utf-8");

    // 复制 notes.md（同步操作，无需等待）
    await browser.execute((path: string) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const fileOps = pinia._s.get("fileOps");
      fileOps.copy(path);
    }, srcPath.replace(/\\/g, "/"));

    // 粘贴到 sub/
    await callStoreAction(browser, "fileOps", "paste", targetDir.replace(/\\/g, "/"));

    // 源文件仍存在（复制语义）
    expect(existsSync(srcPath)).toBe(true);
    // 目标也存在
    const copiedPath = resolve(targetDir, "notes.md");
    expect(existsSync(copiedPath)).toBe(true);
    expect(readFileSync(copiedPath, "utf-8")).toBe(originalContent);
  });

  // ===== H3: 冲突处理对话框 =====

  it("重命名到已存在文件名：触发冲突对话框，选择取消则不修改", async () => {
    // 模拟将 intro.md 重命名为 notes.md（已存在）
    // 需要注入冲突 resolver：因为 setConflictResolver 由 App.vue 注入，E2E 中需要重新注入
    await browser.execute(() => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const fileOps = pinia._s.get("fileOps");
      const dialog = pinia._s.get("dialog");

      // 注入 resolver：使用 dialog.conflict
      fileOps.setConflictResolver(async (targetPath: string, operation: string, sourcePath?: string) => {
        return dialog.conflict({
          filename: targetPath.split(/[\\/]/).pop() ?? "",
          sourcePath,
          operation: operation as any,
        });
      });
    });

    const oldPath = resolve(wsPath, "intro.md");

    // 1. Start rename without blocking — executeAsync 会阻塞 session 直到 done 被调用，
    //    导致后续 button click 命令无法送达浏览器（script timeout 死锁）。
    //    改用同步 execute 启动异步操作，结果暂存到 window.__testResult。
    await browser.execute((old: string, newName: string) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const fileOps = pinia._s.get("fileOps");
      (window as any).__testResult = null;
      Promise.resolve(fileOps.renamePath(old, newName))
        .then((node: any) => { (window as any).__testResult = { ok: true, node: node ? { name: node.name } : null }; })
        .catch((err: any) => { (window as any).__testResult = { ok: false, error: err ? String(err) : null }; });
    }, oldPath.replace(/\\/g, "/"), "notes.md");

    // 2. 等待冲突对话框出现（用 waitForExist 而非 waitForDisplayed，Vue Transition 会让元素
    //    存在但 opacity:0 延迟显示，waitForDisplayed 可能误判）
    const dialogEl = await browser.$(".dialog-overlay");
    await dialogEl.waitForExist({ timeout: 5000 });

    // 3. 点击取消按钮（conflict footer 第一个非 primary/非 danger 按钮，cancelText="取消"）
    const cancelBtn = await browser.$(".dialog-footer .dialog-btn:not(.primary):not(.danger)");
    if (await cancelBtn.isExisting()) {
      await cancelBtn.click();
    } else {
      // 回退：通过 store 直接 cancelCurrent
      await browser.execute(() => {
        // @ts-ignore
        const pinia = window.__pinia__;
        const dialog = pinia._s.get("dialog");
        dialog.cancelCurrent();
      });
    }

    // 4. Poll for result（对话框 resolve 后 renamePath promise 才会 settle）
    await browser.waitUntil(
      async () => await browser.execute(() => (window as any).__testResult),
      { timeout: 5000, interval: 100 }
    );
    const result = await browser.execute(() => (window as any).__testResult);

    expect((result as any).ok).toBe(true);
    expect((result as any).node).toBeNull();

    // intro.md 仍存在，notes.md 也未被覆盖
    expect(existsSync(resolve(wsPath, "intro.md"))).toBe(true);
    expect(existsSync(resolve(wsPath, "notes.md"))).toBe(true);
  });

  it("重命名到已存在文件名：选择覆盖则源文件替换目标", async () => {
    await browser.execute(() => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const fileOps = pinia._s.get("fileOps");
      const dialog = pinia._s.get("dialog");
      fileOps.setConflictResolver(async (targetPath: string, operation: string, sourcePath?: string) => {
        return dialog.conflict({
          filename: targetPath.split(/[\\/]/).pop() ?? "",
          sourcePath,
          operation: operation as any,
        });
      });
    });

    const srcPath = resolve(wsPath, "intro.md");
    const targetName = "notes.md";
    const originalIntro = readFileSync(srcPath, "utf-8");

    // 1. Start rename without blocking — executeAsync 会阻塞 session 直到 done 被调用，
    //    导致后续 button click 命令无法送达浏览器（script timeout 死锁）。
    //    改用同步 execute 启动异步操作，结果暂存到 window.__testResult。
    await browser.execute((old: string, newName: string) => {
      // @ts-ignore
      const pinia = window.__pinia__;
      const fileOps = pinia._s.get("fileOps");
      (window as any).__testResult = null;
      Promise.resolve(fileOps.renamePath(old, newName))
        .then((node: any) => { (window as any).__testResult = { ok: true, node: node ? { name: node.name } : null }; })
        .catch((err: any) => { (window as any).__testResult = { ok: false, error: err ? String(err) : null }; });
    }, srcPath.replace(/\\/g, "/"), targetName);

    // 2. 等待对话框出现并点击"覆盖"（用 waitForExist 而非 waitForDisplayed，Vue Transition
    //    会让元素存在但 opacity:0 延迟显示）
    const dialogEl = await browser.$(".dialog-overlay");
    await dialogEl.waitForExist({ timeout: 5000 });

    // 3. 点击覆盖按钮（conflict 默认 confirmText="覆盖"，class 含 danger）
    const overwriteBtn = await browser.$(".dialog-footer .dialog-btn.danger");
    if (await overwriteBtn.isExisting()) {
      await overwriteBtn.click();
    } else {
      // 回退：通过 store 直接 conflictOverwrite
      await browser.execute(() => {
        // @ts-ignore
        const pinia = window.__pinia__;
        const dialog = pinia._s.get("dialog");
        dialog.conflictOverwrite();
      });
    }

    // 4. Poll for result（对话框 resolve 后 renamePath promise 才会 settle）
    await browser.waitUntil(
      async () => await browser.execute(() => (window as any).__testResult),
      { timeout: 5000, interval: 100 }
    );
    const result = await browser.execute(() => (window as any).__testResult);

    expect((result as any).ok).toBe(true);

    // intro.md 已不存在（被重命名走）
    expect(existsSync(srcPath)).toBe(false);
    // notes.md 内容应等于原 intro.md 的内容（覆盖后 rename 写入）
    const finalContent = readFileSync(resolve(wsPath, targetName), "utf-8");
    expect(finalContent).toBe(originalIntro);
  });

  it("目录覆盖被禁止：重命名到已存在目录时报错", async () => {
    // 先关闭工作区（停止文件监听），再重置磁盘
    try {
      await closeWorkspace(browser);
    } catch {
      /* ignore */
    }
    await browser.pause(200);
    // 在 wsPath 下创建两个目录，尝试将 one 重命名为 two（two 已存在）
    resetWorkspace([
      ...defaultFixtureFiles(),
      { path: "one/file.md", content: "# one" },
      { path: "two/file.md", content: "# two" },
    ]);
    // 重新打开工作区以加载新 fixture
    await openWorkspace(browser, wsPath);
    await (await browser.$(".file-tree")).waitForExist({ timeout: 10000 });

    const srcPath = resolve(wsPath, "one");
    const targetName = "two";

    // fileOps.renamePath 对目录目标抛出 "无法覆盖目录" 错误。
    // callStoreAction 内部用 execute + 轮询模式，错误会被 .catch() 捕获并存入
    // window.__testResult，然后 callStoreAction 将其转为 thrown Error。
    let caughtError: Error | null = null;
    try {
      await callStoreAction(browser, "fileOps", "renamePath", srcPath.replace(/\\/g, "/"), targetName);
    } catch (err: unknown) {
      caughtError = err instanceof Error ? err : new Error(String(err));
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toContain("目录");

    // 两个目录都应仍存在
    expect(existsSync(resolve(wsPath, "one"))).toBe(true);
    expect(existsSync(resolve(wsPath, "two"))).toBe(true);
  });

  // ===== 清理：移除冲突 resolver，避免污染后续 spec =====
  afterAll(async () => {
    if (browser) {
      try {
        await browser.execute(() => {
          // @ts-ignore
          const pinia = window.__pinia__;
          const fileOps = pinia?._s?.get("fileOps");
          if (fileOps) fileOps.setConflictResolver(null);
        });
      } catch {
        /* ignore */
      }
    }
  });
});
