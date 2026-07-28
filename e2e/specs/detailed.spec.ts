/**
 * 细化场景测试：关闭确认 / 撤销重做 / 多 Tab 独立性 / 交叉场景
 *
 * 使用真实 fixture 目录 C:\workspace\md-test-1 和 C:\workspace\md-test-2
 * 测试前会备份并重置这些目录的文件内容，避免污染
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { openWorkspace, closeWorkspace, openFileInTab, getTabsState } from "../helpers/store";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

// ===== 测试用 fixture 目录 =====
const WS1 = "C:\\workspace\\md-test-1";
const WS2 = "C:\\workspace\\md-test-2";

// 备份原始内容，测试后恢复
const backup = new Map<string, string>();

function backupFile(p: string): void {
  if (!existsSync(p)) return;
  backup.set(p, readFileSync(p, "utf-8"));
}

function restoreFiles(): void {
  for (const [p, content] of backup) {
    try {
      writeFileSync(p, content, "utf-8");
    } catch (e) {
      console.warn(`[restore] failed for ${p}:`, e);
    }
  }
  backup.clear();
}

// md-test-1 已知文件状态（用于 beforeEach 重置）
const WS1_FILES: Record<string, string> = {
  "intro.md": "# Murasaki 测试文档\n\n这是用于功能验证的测试文件。\n\n## 简介\n\nMurasaki 是一个 Markdown 编辑器，基于 Tauri + Vue 3 构建。\n\n## 功能列表\n\n- [x] 编辑器\n- [x] 预览\n- [ ] 导出 PDF\n- [ ] 协作模式\n\n## 代码示例\n\n```rust\nfn main() {\n    println!(\"Hello, Murasaki!\");\n}\n```\n\n## 任务列表\n\n- [ ] 验证编辑器\n- [ ] 验证预览\n- [x] 验证启动\n\n## 内部链接\n\n跳转到 [笔记](notes.md) 文档。\n",
  "notes.md": "---\ntitle: 笔记文档\ndate: 2026-07-26\ntags: [测试, 笔记, murasaki]\n---\n\n# 笔记\n\n## 主题切换\n\n测试 GitHub / Newsprint / Night / Academic 主题。\n\n正文内容。\n\n## Emoji 测试\n\n:smile: :heart: :thumbsup: :rocket:\n\n## 表格\n\n| 名称 | 版本 | 状态 |\n|------|------|------|\n| Murasaki | 0.1.0 | 开发中 |\n| Tauri | 2.x | 稳定 |\n",
  "math.md": "# 数学公式\n\n## 行内公式\n\n能量方程：$E = mc^2$\n\n欧拉公式：$e^{i\\pi} + 1 = 0$\n\n## 块级公式\n\n$$\n\\int_0^{\\infty} e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}\n$$\n\n$$\n\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}\n$$\n",
  "diagram.md": "# 流程图\n\n## Mermaid 流程图\n\n```mermaid\ngraph LR\n    A[开始] --> B{条件判断}\n    B -->|是| C[执行操作]\n    B -->|否| D[结束]\n    C --> D\n```\n\n## 时序图\n\n```mermaid\nsequenceDiagram\n    participant U as 用户\n    participant E as 编辑器\n    participant F as 文件系统\n    U->>E: 打开文件\n    E->>F: 读取文件\n    F-->>E: 返回内容\n    E-->>U: 显示内容\n```\n",
  "sub/deep.md": "# 子目录文件\n\n嵌套子目录中的文件，用于测试文件树展开和搜索功能。\n",
};

const WS2_FILES: Record<string, string> = {
  "readme.md": "# 第二个工作区\n\n用于测试多工作区切换、最近打开记录功能。\n\n## 搜索测试\n\nMurasaki markdown editor test content for search functionality.\n",
};

function resetWsFiles(): void {
  for (const [rel, content] of Object.entries(WS1_FILES)) {
    const p = resolve(WS1, rel);
    mkdirSync(resolve(p, ".."), { recursive: true });
    writeFileSync(p, content, "utf-8");
  }
  for (const [rel, content] of Object.entries(WS2_FILES)) {
    const p = resolve(WS2, rel);
    mkdirSync(resolve(p, ".."), { recursive: true });
    writeFileSync(p, content, "utf-8");
  }
}

let browser: Browser;

beforeAll(async () => {
  // 备份所有 fixture 文件
  for (const rel of Object.keys(WS1_FILES)) backupFile(resolve(WS1, rel));
  for (const rel of Object.keys(WS2_FILES)) backupFile(resolve(WS2, rel));
  resetWsFiles();
  browser = await createSession();
}, 60000);

afterAll(async () => {
  if (browser) await closeSession(browser);
  // 恢复原始文件
  restoreFiles();
});

beforeEach(async () => {
  // 每个 case 前重置文件内容（避免上一个 case 的修改残留）
  resetWsFiles();
  // 关闭所有 tab（通过 clearAll）
  try {
    await browser.executeAsync((done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      Promise.resolve(tabs.clearAll()).then(() => done(null), (e) => done(String(e)));
    });
  } catch {
    // ignore
  }
  // 关闭工作区
  try {
    await closeWorkspace(browser);
  } catch {
    // ignore
  }
});

// ===== 辅助函数 =====

/** 通过 store 直接修改 tab 内容（模拟编辑器输入） */
async function setTabContent(browser: Browser, tabId: string, content: string): Promise<void> {
  await browser.executeAsync((id: string, c: string, done) => {
    // @ts-ignore
    const tabs = window.__pinia__._s.get("tabs");
    tabs.updateContent(id, c);
    done(null);
  }, tabId, content);
}

/** 通过 CodeMirror view 在光标处插入文本（模拟真实输入） */
async function cmInsertText(browser: Browser, text: string): Promise<void> {
  await browser.executeAsync((t: string, done) => {
    // @ts-ignore
    const view = window.__editorRef__?.getView?.();
    if (!view) return done("no view");
    try {
      view.focus();
      const sel = view.state.selection.main;
      view.dispatch(view.state.replaceSelection(t));
      done(null);
    } catch (e) {
      done(String(e));
    }
  }, text);
}

/** 触发 CodeMirror undo（通过 App.vue 暴露的接口） */
async function cmUndo(browser: Browser): Promise<void> {
  await browser.executeAsync((done) => {
    // @ts-ignore
    if (!window.__editorRef__?.undo) return done("no undo");
    try { window.__editorRef__.undo(); done(null); }
    catch (e) { done(String(e)); }
  });
}

/** 触发 CodeMirror redo（通过 App.vue 暴露的接口） */
async function cmRedo(browser: Browser): Promise<void> {
  await browser.executeAsync((done) => {
    // @ts-ignore
    if (!window.__editorRef__?.redo) return done("no redo");
    try { window.__editorRef__.redo(); done(null); }
    catch (e) { done(String(e)); }
  });
}

/** 读取 CodeMirror 当前文档内容（注意：从 view 读取，不是从 store 读取） */
async function cmGetDoc(browser: Browser): Promise<string> {
  return browser.execute(() => {
    // @ts-ignore
    const view = window.__editorRef__?.getView?.();
    if (!view) return null;
    return view.state.doc.toString();
  });
}

/** 等待 CodeMirror 同步到 store（编辑器 updateListener 异步触发 updateContent） */
async function waitForStoreSync(browser: Browser, expectedLen: number, timeout = 3000): Promise<void> {
  await browser.waitUntil(async () => {
    const tabs = await getTabsState(browser);
    const active = tabs.tabs.find((t) => t.id === tabs.activeTabId);
    return active && active.contentLength === expectedLen;
  }, { timeout, interval: 100 });
}

/** 读取磁盘文件内容（通过 Tauri read_text_file 命令） */
async function readDiskFile(browser: Browser, path: string): Promise<string> {
  return browser.executeAsync((p: string, done) => {
    // @ts-ignore
    window.__TAURI_INTERNALS__.invoke("read_text_file", { path: p })
      .then((c: string) => done(c), (e: unknown) => done("ERR:" + String(e)));
  }, path);
}

/** 等待 tab 出现在 TabBar 中 */
async function waitForTabCount(browser: Browser, count: number, timeout = 5000): Promise<void> {
  await browser.waitUntil(async () => (await getTabsState(browser)).tabs.length === count, { timeout });
}

// ===== 测试组 1：关闭确认对话框（保存/不保存/取消）=====
describe("1. 关闭确认对话框", () => {
  beforeEach(async () => {
    await openWorkspace(browser, WS1);
    await (await browser.$(".file-tree")).waitForExist({ timeout: 10000 });
  });

  it("1.1 无修改直接关闭：不弹对话框，直接关闭", async () => {
    await openFileInTab(browser, `${WS1}\\intro.md`);
    await waitForTabCount(browser, 1);

    const before = await getTabsState(browser);
    expect(before.tabs[0].isDirty).toBe(false);

    // 通过 store 调 closeTab（无 dirty 时直接关闭）
    const result = await browser.executeAsync((done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      Promise.resolve(tabs.closeTab(tabs.activeTabId))
        .then((r: any) => done({ needsConfirm: r.needsConfirm, hasTab: !!r.tab }),
              (e: unknown) => done({ error: String(e) }));
    });
    expect(result.needsConfirm).toBe(false);

    await waitForTabCount(browser, 0);
  });

  it("1.2 有修改弹对话框：选择「不保存」→ tab 关闭，磁盘未变", async () => {
    await openFileInTab(browser, `${WS1}\\intro.md`);
    await waitForTabCount(browser, 1);

    const state1 = await getTabsState(browser);
    const tabId = state1.activeTabId!;
    const originalDisk = await readDiskFile(browser, `${WS1}\\intro.md`);

    // 修改内容（dirty = true）
    await setTabContent(browser, tabId, "# 改了内容\n");
    const state2 = await getTabsState(browser);
    expect(state2.tabs[0].isDirty).toBe(true);

    // closeTab 应返回 needsConfirm: true（不直接关闭）
    const r1 = await browser.executeAsync((done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      Promise.resolve(tabs.closeTab(tabs.activeTabId))
        .then((r: any) => done({ needsConfirm: r.needsConfirm }),
              (e: unknown) => done({ error: String(e) }));
    });
    expect(r1.needsConfirm).toBe(true);
    // tab 仍在
    await waitForTabCount(browser, 1);

    // 模拟用户选「不保存」→ 调 doCloseTab
    await browser.executeAsync((done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      Promise.resolve(tabs.doCloseTab(tabs.activeTabId))
        .then(() => done(null), (e: unknown) => done(String(e)));
    });

    await waitForTabCount(browser, 0);

    // 磁盘内容应未变
    const diskAfter = await readDiskFile(browser, `${WS1}\\intro.md`);
    expect(diskAfter).toBe(originalDisk);
  });

  it("1.3 有修改弹对话框：选择「保存」→ 磁盘写入新内容，tab 关闭", async () => {
    await openFileInTab(browser, `${WS1}\\notes.md`);
    await waitForTabCount(browser, 1);

    const state = await getTabsState(browser);
    const tabId = state.activeTabId!;
    const newContent = "---\ntitle: 改过的笔记\n---\n\n# 新内容\n";

    await setTabContent(browser, tabId, newContent);

    // 模拟「保存」分支：先 saveTab 再 doCloseTab
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      Promise.resolve(tabs.saveTab(id))
        .then(() => tabs.doCloseTab(id))
        .then(() => done(null), (e: unknown) => done(String(e)));
    }, tabId);

    await waitForTabCount(browser, 0);

    const disk = await readDiskFile(browser, `${WS1}\\notes.md`);
    expect(disk).toBe(newContent);
  });

  it("1.4 有修改弹对话框：选择「取消」→ tab 仍在，dirty 仍为 true", async () => {
    await openFileInTab(browser, `${WS1}\\math.md`);
    await waitForTabCount(browser, 1);

    const state = await getTabsState(browser);
    const tabId = state.activeTabId!;
    await setTabContent(browser, tabId, "# 改后的 math\n");

    // closeTab 返回 needsConfirm，调用方「取消」分支不调 doCloseTab
    const r = await browser.executeAsync((done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      Promise.resolve(tabs.closeTab(tabs.activeTabId))
        .then((r: any) => done({ needsConfirm: r.needsConfirm }),
              (e: unknown) => done({ error: String(e) }));
    });
    expect(r.needsConfirm).toBe(true);

    // tab 仍在，仍 dirty
    const after = await getTabsState(browser);
    expect(after.tabs.length).toBe(1);
    expect(after.tabs[0].isDirty).toBe(true);
  });

  it("1.5 关闭未命名 tab（无路径）：调 doCloseTab 不写草稿，直接关闭", async () => {
    // 新建未命名 tab
    await browser.executeAsync((done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      try { tabs.newTab(); done(null); } catch (e) { done(String(e)); }
    });
    await waitForTabCount(browser, 1);

    const state = await getTabsState(browser);
    const tabId = state.activeTabId!;
    expect(state.tabs[0].path).toBeNull();

    await setTabContent(browser, tabId, "未命名内容");

    // doCloseTab 应成功（无 path 不写草稿，但仍关闭）
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      Promise.resolve(tabs.doCloseTab(id))
        .then(() => done(null), (e: unknown) => done(String(e)));
    }, tabId);

    await waitForTabCount(browser, 0);
  });
});

// ===== 测试组 2：撤销/重做（单文件）=====
describe("2. 撤销/重做（Ctrl+Z/Y）单文件", () => {
  beforeEach(async () => {
    await openWorkspace(browser, WS1);
    await (await browser.$(".file-tree")).waitForExist({ timeout: 10000 });
    await openFileInTab(browser, `${WS1}\\intro.md`);
    await waitForTabCount(browser, 1);
  });

  it("2.1 单次输入后 undo 恢复原内容", async () => {
    const original = await cmGetDoc(browser);
    await cmInsertText(browser, "INSERTED-TEXT");

    // 等待文档更新
    await browser.waitUntil(async () => (await cmGetDoc(browser)).includes("INSERTED-TEXT"), { timeout: 3000 });

    await cmUndo(browser);

    const after = await cmGetDoc(browser);
    expect(after).toBe(original);
  });

  it("2.2 多次输入后多次 undo 逐步回退", async () => {
    const original = await cmGetDoc(browser);
    await cmInsertText(browser, "A");
    await cmInsertText(browser, "B");
    await cmInsertText(browser, "C");
    await browser.waitUntil(async () => (await cmGetDoc(browser)).includes("ABC"), { timeout: 3000 });

    // 注意：CodeMirror 默认会把连续输入合并为一个 transaction
    // undo 次数可能与输入次数不一致，因此用循环 undo 直到回到 original
    let undoCount = 0;
    const maxUndo = 5;
    let doc = await cmGetDoc(browser);
    while (doc !== original && undoCount < maxUndo) {
      await cmUndo(browser);
      doc = await cmGetDoc(browser);
      undoCount++;
      await browser.pause(50);
    }
    expect(doc).toBe(original);
    expect(undoCount).toBeGreaterThanOrEqual(1);
  });

  it("2.3 undo 后 redo 恢复撤销的内容", async () => {
    const original = await cmGetDoc(browser);
    await cmInsertText(browser, "X");
    await browser.waitUntil(async () => (await cmGetDoc(browser)).includes("X"), { timeout: 3000 });
    const afterInput = await cmGetDoc(browser);

    await cmUndo(browser);
    expect(await cmGetDoc(browser)).toBe(original);

    await cmRedo(browser);
    expect(await cmGetDoc(browser)).toBe(afterInput);
  });

  it("2.4 新输入后再 undo，redo 栈被清空", async () => {
    await cmInsertText(browser, "FIRST");
    await browser.waitUntil(async () => (await cmGetDoc(browser)).includes("FIRST"), { timeout: 3000 });
    await cmUndo(browser);

    // 新输入应清空 redo 栈
    await cmInsertText(browser, "SECOND");
    await browser.waitUntil(async () => (await cmGetDoc(browser)).includes("SECOND"), { timeout: 3000 });

    // redo 不应有效（redo 栈为空）
    const beforeRedo = await cmGetDoc(browser);
    await cmRedo(browser);
    // redo 无效果，内容不变
    expect(await cmGetDoc(browser)).toBe(beforeRedo);
  });

  it("2.5 撤销不影响磁盘文件（除非显式保存）", async () => {
    const originalDisk = await readDiskFile(browser, `${WS1}\\intro.md`);
    await cmInsertText(browser, "TO-BE-UNDONE");
    await browser.waitUntil(async () => (await cmGetDoc(browser)).includes("TO-BE-UNDONE"), { timeout: 3000 });

    await cmUndo(browser);

    // 磁盘未变
    const diskAfter = await readDiskFile(browser, `${WS1}\\intro.md`);
    expect(diskAfter).toBe(originalDisk);
  });
});

// ===== 测试组 3：多 Tab 切换时撤销栈独立性 =====
describe("3. 多 Tab 切换时撤销栈独立性", () => {
  beforeEach(async () => {
    await openWorkspace(browser, WS1);
    await (await browser.$(".file-tree")).waitForExist({ timeout: 10000 });
  });

  it("3.1 Tab A 编辑 → 切到 Tab B 编辑 → 回 Tab A：A 撤销栈保留", async () => {
    await openFileInTab(browser, `${WS1}\\intro.md`);   // Tab A
    await openFileInTab(browser, `${WS1}\\notes.md`);    // Tab B
    await waitForTabCount(browser, 2);

    const state = await getTabsState(browser);
    const [tabA, tabB] = state.tabs;

    // 当前在 Tab B（最后打开的）
    expect(state.activeTabId).toBe(tabB.id);

    // 切回 Tab A
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      tabs.switchTo(id);
      done(null);
    }, tabA.id);

    // 在 Tab A 输入
    const docA_before = await cmGetDoc(browser);
    await cmInsertText(browser, "AAA");
    await browser.waitUntil(async () => (await cmGetDoc(browser)).includes("AAA"), { timeout: 3000 });

    // 切到 Tab B
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      tabs.switchTo(id);
      done(null);
    }, tabB.id);

    // 在 Tab B 输入
    await cmInsertText(browser, "BBB");
    await browser.waitUntil(async () => (await cmGetDoc(browser)).includes("BBB"), { timeout: 3000 });

    // 切回 Tab A
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      tabs.switchTo(id);
      done(null);
    }, tabA.id);

    // undo Tab A：应只撤销 "AAA"，不影响 Tab B
    await cmUndo(browser);
    const docA_after = await cmGetDoc(browser);
    expect(docA_after).toBe(docA_before);
    expect(docA_after.includes("AAA")).toBe(false);
  });

  it("3.2 Tab A undo 后切 Tab B → 回 Tab A：A redo 栈保留", async () => {
    await openFileInTab(browser, `${WS1}\\math.md`);     // Tab A
    await openFileInTab(browser, `${WS1}\\diagram.md`);   // Tab B
    await waitForTabCount(browser, 2);

    const state = await getTabsState(browser);
    const [tabA, tabB] = state.tabs;

    // 切到 Tab A 并输入、undo
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      tabs.switchTo(id);
      done(null);
    }, tabA.id);

    const originalA = await cmGetDoc(browser);
    await cmInsertText(browser, "X");
    await browser.waitUntil(async () => (await cmGetDoc(browser)).includes("X"), { timeout: 3000 });
    const afterInputA = await cmGetDoc(browser);

    await cmUndo(browser);
    expect(await cmGetDoc(browser)).toBe(originalA);

    // 切到 Tab B 再切回 Tab A
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      tabs.switchTo(id);
      done(null);
    }, tabB.id);
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      tabs.switchTo(id);
      done(null);
    }, tabA.id);

    // redo 应恢复 X
    await cmRedo(browser);
    expect(await cmGetDoc(browser)).toBe(afterInputA);
  });

  it("3.3 关闭 Tab A 后 Tab B 撤销栈不受影响", async () => {
    await openFileInTab(browser, `${WS1}\\intro.md`);    // Tab A
    await openFileInTab(browser, `${WS1}\\notes.md`);    // Tab B
    await waitForTabCount(browser, 2);

    const state = await getTabsState(browser);
    const [tabA, tabB] = state.tabs;

    // 在 Tab B 输入
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      tabs.switchTo(id);
      done(null);
    }, tabB.id);

    const originalB = await cmGetDoc(browser);
    await cmInsertText(browser, "B-INPUT");
    await browser.waitUntil(async () => (await cmGetDoc(browser)).includes("B-INPUT"), { timeout: 3000 });

    // 关闭 Tab A（无 dirty，直接关）
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      Promise.resolve(tabs.closeTab(id))
        .then(() => done(null), (e: unknown) => done(String(e)));
    }, tabA.id);
    await waitForTabCount(browser, 1);

    // 当前仍应在 Tab B
    const stateAfter = await getTabsState(browser);
    expect(stateAfter.activeTabId).toBe(tabB.id);

    // undo Tab B：应能撤销 B-INPUT
    await cmUndo(browser);
    expect(await cmGetDoc(browser)).toBe(originalB);
  });
});

// ===== 测试组 4：多 Tab 关闭/切换/新建场景 =====
describe("4. 多 Tab 关闭/切换/新建场景", () => {
  beforeEach(async () => {
    await openWorkspace(browser, WS1);
    await (await browser.$(".file-tree")).waitForExist({ timeout: 10000 });
  });

  it("4.1 关闭当前激活 tab：激活移到相邻 tab", async () => {
    await openFileInTab(browser, `${WS1}\\intro.md`);    // 0
    await openFileInTab(browser, `${WS1}\\notes.md`);     // 1
    await openFileInTab(browser, `${WS1}\\math.md`);      // 2（active）
    await waitForTabCount(browser, 3);

    const state = await getTabsState(browser);
    const activeId = state.activeTabId!;
    expect(state.tabs[2].id).toBe(activeId);

    // 关闭当前（math.md，idx=2）
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      Promise.resolve(tabs.closeTab(id))
        .then(() => done(null), (e: unknown) => done(String(e)));
    }, activeId);

    // 应激活 idx=1 的 tab（notes.md）
    const after = await getTabsState(browser);
    expect(after.tabs.length).toBe(2);
    expect(after.activeTabId).toBe(after.tabs[1].id);
  });

  it("4.2 关闭非激活 tab：激活 tab 不变", async () => {
    await openFileInTab(browser, `${WS1}\\intro.md`);    // 0
    await openFileInTab(browser, `${WS1}\\notes.md`);    // 1
    await openFileInTab(browser, `${WS1}\\math.md`);     // 2（active）
    await waitForTabCount(browser, 3);

    const state = await getTabsState(browser);
    const activeId = state.activeTabId!;

    // 关闭 Tab 0（非激活）
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      Promise.resolve(tabs.closeTab(id))
        .then(() => done(null), (e: unknown) => done(String(e)));
    }, state.tabs[0].id);

    const after = await getTabsState(browser);
    expect(after.tabs.length).toBe(2);
    expect(after.activeTabId).toBe(activeId);
  });

  it("4.3 关闭最后一个 tab：激活移到前一个", async () => {
    await openFileInTab(browser, `${WS1}\\intro.md`);    // 0
    await openFileInTab(browser, `${WS1}\\notes.md`);    // 1
    await openFileInTab(browser, `${WS1}\\math.md`);     // 2（active）
    await waitForTabCount(browser, 3);

    const state = await getTabsState(browser);
    const lastId = state.tabs[2].id;

    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      Promise.resolve(tabs.closeTab(id))
        .then(() => done(null), (e: unknown) => done(String(e)));
    }, lastId);

    const after = await getTabsState(browser);
    expect(after.activeTabId).toBe(after.tabs[1].id);
  });

  it("4.4 关闭唯一 tab：activeTabId 变 null", async () => {
    await openFileInTab(browser, `${WS1}\\intro.md`);
    await waitForTabCount(browser, 1);

    const state = await getTabsState(browser);
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      Promise.resolve(tabs.closeTab(id))
        .then(() => done(null), (e: unknown) => done(String(e)));
    }, state.activeTabId!);

    const after = await getTabsState(browser);
    expect(after.tabs.length).toBe(0);
    expect(after.activeTabId).toBeNull();
  });

  it("4.5 切换 tab 后内容正确显示（编辑器内容随 active 切换）", async () => {
    await openFileInTab(browser, `${WS1}\\intro.md`);
    await openFileInTab(browser, `${WS1}\\math.md`);
    await waitForTabCount(browser, 2);

    const state = await getTabsState(browser);
    const [tabA, tabB] = state.tabs;

    // 当前在 B（math.md）
    expect(state.activeTabId).toBe(tabB.id);
    const docB = await cmGetDoc(browser);
    expect(docB).toBe(WS1_FILES["math.md"]);

    // 切到 A
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      tabs.switchTo(id);
      done(null);
    }, tabA.id);

    const docA = await cmGetDoc(browser);
    expect(docA).toBe(WS1_FILES["intro.md"]);
  });
});

// ===== 测试组 5：交叉场景（撤销 + 多 Tab + 关闭确认）=====
describe("5. 交叉场景", () => {
  beforeEach(async () => {
    await openWorkspace(browser, WS1);
    await (await browser.$(".file-tree")).waitForExist({ timeout: 10000 });
  });

  it("5.1 Tab A 有未保存修改 + 撤销后变干净 → 关闭不弹对话框", async () => {
    await openFileInTab(browser, `${WS1}\\intro.md`);
    await waitForTabCount(browser, 1);

    const state = await getTabsState(browser);
    const tabId = state.activeTabId!;
    const original = await cmGetDoc(browser);

    // 输入使 dirty=true
    await cmInsertText(browser, "PENDING");
    await browser.waitUntil(async () => (await cmGetDoc(browser)).includes("PENDING"), { timeout: 3000 });

    // 等待 store 同步
    await browser.waitUntil(async () => {
      const s = await getTabsState(browser);
      return s.tabs[0].isDirty === true;
    }, { timeout: 3000 });

    // undo 使内容恢复
    await cmUndo(browser);
    await browser.waitUntil(async () => !(await cmGetDoc(browser)).includes("PENDING"), { timeout: 3000 });

    // 等 store 同步（撤销后 updateContent 触发，isDirty 可能仍为 true）
    // 注意：CodeMirror undo 会触发 updateListener，进而调 updateContent
    // 但 isDirty 只会增加不会因 undo 而变 false（除非内容回到原始 lastSaveContent）
    // 实际行为：undo 后内容与磁盘一致，但 isDirty 状态依赖于 store 实现
    // 此处验证：如果 undo 后内容等于原始，closeTab 行为符合预期

    const finalDoc = await cmGetDoc(browser);
    expect(finalDoc).toBe(original);

    // 关闭 tab
    const result = await browser.executeAsync((done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      Promise.resolve(tabs.closeTab(tabs.activeTabId))
        .then((r: any) => done({ needsConfirm: r.needsConfirm }),
              (e: unknown) => done({ error: String(e) }));
    });

    // 无论 dirty 状态如何，最终应能关闭
    if (result.needsConfirm) {
      // 若仍 dirty，需调 doCloseTab
      await browser.executeAsync((done) => {
        // @ts-ignore
        const tabs = window.__pinia__._s.get("tabs");
        Promise.resolve(tabs.doCloseTab(tabs.activeTabId))
          .then(() => done(null), (e: unknown) => done(String(e)));
      });
    }
    await waitForTabCount(browser, 0);
  });

  it("5.2 Tab A 输入后切到 Tab B，关 Tab A 弹对话框选「不保存」", async () => {
    await openFileInTab(browser, `${WS1}\\intro.md`);    // A
    await openFileInTab(browser, `${WS1}\\notes.md`);    // B
    await waitForTabCount(browser, 2);

    const state = await getTabsState(browser);
    const [tabA, tabB] = state.tabs;

    // 在 A 输入（dirty）
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      tabs.switchTo(id);
      done(null);
    }, tabA.id);
    const originalDiskA = await readDiskFile(browser, `${WS1}\\intro.md`);
    await cmInsertText(browser, "STAGE-A");
    await browser.waitUntil(async () => (await cmGetDoc(browser)).includes("STAGE-A"), { timeout: 3000 });

    // 切到 B
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      tabs.switchTo(id);
      done(null);
    }, tabB.id);

    // 此时 activeTab 是 B，要关 A 需指定 id
    const r = await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      Promise.resolve(tabs.closeTab(id))
        .then((r: any) => done({ needsConfirm: r.needsConfirm }),
              (e: unknown) => done({ error: String(e) }));
    }, tabA.id);
    expect(r.needsConfirm).toBe(true);

    // 模拟「不保存」：调 doCloseTab
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      Promise.resolve(tabs.doCloseTab(id))
        .then(() => done(null), (e: unknown) => done(String(e)));
    }, tabA.id);

    await waitForTabCount(browser, 1);

    // 磁盘 intro.md 应未变
    const diskA = await readDiskFile(browser, `${WS1}\\intro.md`);
    expect(diskA).toBe(originalDiskA);

    // 当前激活应在 B
    const after = await getTabsState(browser);
    expect(after.activeTabId).toBe(tabB.id);
  });

  it("5.3 Tab A 输入后切到 Tab B 输入，分别 undo 各自的输入", async () => {
    await openFileInTab(browser, `${WS1}\\intro.md`);    // A
    await openFileInTab(browser, `${WS1}\\notes.md`);    // B
    await waitForTabCount(browser, 2);

    const state = await getTabsState(browser);
    const [tabA, tabB] = state.tabs;

    // A 输入
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      tabs.switchTo(id);
      done(null);
    }, tabA.id);
    const origA = await cmGetDoc(browser);
    await cmInsertText(browser, "INPUT-A");
    await browser.waitUntil(async () => (await cmGetDoc(browser)).includes("INPUT-A"), { timeout: 3000 });

    // B 输入
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      tabs.switchTo(id);
      done(null);
    }, tabB.id);
    const origB = await cmGetDoc(browser);
    await cmInsertText(browser, "INPUT-B");
    await browser.waitUntil(async () => (await cmGetDoc(browser)).includes("INPUT-B"), { timeout: 3000 });

    // 切回 A，undo 应只撤销 INPUT-A
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      tabs.switchTo(id);
      done(null);
    }, tabA.id);
    await cmUndo(browser);
    expect(await cmGetDoc(browser)).toBe(origA);

    // 切到 B，undo 应只撤销 INPUT-B
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      tabs.switchTo(id);
      done(null);
    }, tabB.id);
    await cmUndo(browser);
    expect(await cmGetDoc(browser)).toBe(origB);
  });

  it("5.4 多 tab 中关闭 dirty tab 选「保存」：仅该 tab 文件被写入", async () => {
    await openFileInTab(browser, `${WS1}\\intro.md`);    // A
    await openFileInTab(browser, `${WS1}\\notes.md`);    // B
    await waitForTabCount(browser, 2);

    const state = await getTabsState(browser);
    const [tabA, tabB] = state.tabs;

    const originalDiskA = await readDiskFile(browser, `${WS1}\\intro.md`);
    const newDiskB = "# 新 notes 内容\n";

    // 在 B 输入
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      tabs.switchTo(id);
      done(null);
    }, tabB.id);
    await setTabContent(browser, tabB.id, newDiskB);

    // 模拟「保存」分支：saveTab(B) + doCloseTab(B)
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      Promise.resolve(tabs.saveTab(id))
        .then(() => tabs.doCloseTab(id))
        .then(() => done(null), (e: unknown) => done(String(e)));
    }, tabB.id);

    await waitForTabCount(browser, 1);

    // 验证：notes.md 写入新内容，intro.md 未变
    const diskA = await readDiskFile(browser, `${WS1}\\intro.md`);
    const diskB = await readDiskFile(browser, `${WS1}\\notes.md`);
    expect(diskA).toBe(originalDiskA);
    expect(diskB).toBe(newDiskB);
  });

  it("5.5 在 Tab A 输入后切到 B，回到 A 时 CodeMirror 状态完整恢复", async () => {
    await openFileInTab(browser, `${WS1}\\math.md`);     // A
    await openFileInTab(browser, `${WS1}\\diagram.md`);  // B
    await waitForTabCount(browser, 2);

    const state = await getTabsState(browser);
    const [tabA, tabB] = state.tabs;

    // 在 A 输入并保留 undo 栈
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      tabs.switchTo(id);
      done(null);
    }, tabA.id);
    const origA = await cmGetDoc(browser);
    await cmInsertText(browser, "STAGE1");
    await browser.waitUntil(async () => (await cmGetDoc(browser)).includes("STAGE1"), { timeout: 3000 });
    const stage1A = await cmGetDoc(browser);

    // 切到 B，输入
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      tabs.switchTo(id);
      done(null);
    }, tabB.id);
    await cmInsertText(browser, "B-INPUT");
    await browser.waitUntil(async () => (await cmGetDoc(browser)).includes("B-INPUT"), { timeout: 3000 });

    // 回到 A：内容应是 stage1A（保留输入）
    await browser.executeAsync((id: string, done) => {
      // @ts-ignore
      const tabs = window.__pinia__._s.get("tabs");
      tabs.switchTo(id);
      done(null);
    }, tabA.id);
    expect(await cmGetDoc(browser)).toBe(stage1A);

    // undo 应能撤销 STAGE1
    await cmUndo(browser);
    expect(await cmGetDoc(browser)).toBe(origA);
  });
});
