/**
 * 工作区 + 文件树 测试
 * 验证：
 * - 通过 store action 直接打开工作区（绕过原生对话框）
 * - 文件树显示工作区中的所有 .md 文件
 * - 点击文件树节点打开新 Tab
 * - 关闭工作区后侧栏消失
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace, defaultFixtureFiles } from "../helpers/fixtures";
import { openWorkspace, closeWorkspace, closeAllTabs, waitForPinia, resetPersistenceSettings } from "../helpers/store";
import { waitForInBrowser, waitForPresent } from "../helpers/wait";

let browser: Browser;

describe("工作区 + 文件树", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  beforeEach(async () => {
    await resetPersistenceSettings(browser);
    // 每个测试前重置工作区并关闭已打开的工作区和 tabs
    // 避免前序测试的 tab 残留导致 sidebar 不消失（App.vue v-if="hasWorkspace || hasTabs"）
    resetWorkspace(defaultFixtureFiles());
    try {
      await closeAllTabs(browser);
      await closeWorkspace(browser);
    } catch {
      // 首次启动无工作区，忽略
    }
  });

  it("打开工作区后侧栏可见", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);

    const tree = await browser.$(".file-tree");
    await waitForPresent(browser, ".file-tree", 10000);
    expect(await tree.isDisplayed()).toBe(true);
  });

  it("文件树显示工作区名作为标题", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);

    const title = await browser.$(".file-tree .toolbar-title");
    await waitForPresent(browser, ".file-tree .toolbar-title", 10000);
    const text = (await title.getText()).trim();
    expect(text.length).toBeGreaterThan(0);
    // 工作区目录名应出现在标题中（fixture 目录名 .workspace 被 UI 大写显示为 .WORKSPACE）
    expect(text.toLowerCase()).toContain("workspace");
  });

  it("文件树列出所有 .md 文件（含子目录）", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);

    // 等待 tree-node 出现
    const nodes = await browser.$$(".file-tree .tree-node");
    expect(nodes.length).toBeGreaterThanOrEqual(2); // intro.md, notes.md, sub/ 至少 3 个

    // 验证节点名称包含 intro.md 和 notes.md
    const names = await browser.$$(".file-tree .node-name");
    const texts: string[] = [];
    for (const n of names) {
      texts.push((await n.getText()).trim());
    }
    expect(texts).toEqual(expect.arrayContaining(["intro.md", "notes.md", "sub"]));
  });

  it("点击文件树中的 .md 文件打开新 Tab", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);

    // 点击 intro.md（用 XPath 文本匹配，避免 CSS 与 =text 混用）
    const node = await browser.$(
      '//div[contains(@class, "file-tree")]//span[contains(@class, "node-name") and normalize-space()="intro.md"]'
    );
    await waitForPresent(
      browser,
      '//div[contains(@class, "file-tree")]//span[contains(@class, "node-name") and normalize-space()="intro.md"]',
      10000
    );
    await node.click();

    // 等 tab 栏出现名为 intro.md 且真正渲染出来的标签。
    // 必须手写轮询：元素等待命令（waitForExist / waitForDisplayed）在 tauri-driver +
    // msedgedriver 下**不重试**（对不存在的元素 ~10ms 内即抛错），本地跑得快掩盖了
    // 这一点，CI 上就成片失败（#266）。
    const tabRendered = await waitForInBrowser(
      browser,
      (name: string) =>
        Array.from(document.querySelectorAll(".tab-bar-container .tab-title")).some((el) => {
          const rect = (el as HTMLElement).getBoundingClientRect();
          return (
            (el.textContent ?? "").trim() === name && rect.width > 0 && rect.height > 0
          );
        }),
      ["intro.md"],
      { timeout: 15000, message: 'tab 栏出现已渲染的 "intro.md" 标签' }
    );
    expect(tabRendered).toBe(true);
  });

  it("关闭工作区后侧栏消失", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);
    const tree = await browser.$(".file-tree");
    await waitForPresent(browser, ".file-tree", 10000);
    expect(await tree.isDisplayed()).toBe(true);

    await closeWorkspace(browser);

    // 侧栏消失
    await browser.waitUntil(
      async () => !(await browser.$(".file-tree").isExisting()),
      { timeout: 5000 }
    );
  });

  it("刷新按钮在合理时间内停止动画", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openWorkspace(browser, wsPath);

    // 等待文件树渲染（刷新按钮在 .file-tree 的 toolbar 内）
    await waitForPresent(browser, ".file-tree", 10000);

    // 点击刷新按钮（FileTree.vue 中 title="刷新" 的 NButton）
    const refreshBtn = await browser.$(".file-tree button[title='刷新']");
    await waitForPresent(browser, ".file-tree button[title='刷新']", 5000);
    await refreshBtn.click();

    // 等待 loading 归位。预算 45s **必须大于** refreshTree 自身的 30s 兜底
    // （src/stores/useWorkspaceStore.ts 的 REFRESH_TIMEOUT_MS）：本用例断言的是
    // 「不会永久卡住」，给到正好 30s 就是与那个兜底抢跑，CI 上必然输（#266）。
    // 手写轮询的理由同上一处：元素等待命令在本栈下不重试。
    const loadingStopped = await waitForInBrowser(
      browser,
      () => {
        // @ts-ignore
        const ws = window.__pinia__._s.get("workspace");
        return ws.loading === false;
      },
      [],
      { timeout: 45000, interval: 500, message: "刷新按钮停止 loading" }
    );
    expect(loadingStopped).toBe(true);
  });
});
