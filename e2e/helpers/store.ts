/**
 * 通过 browser.execute 访问前端 Pinia store
 * 依赖 main.ts 中暴露的 window.__pinia__
 */
import type { Browser } from "webdriverio";

/** 获取 store 实例（在浏览器上下文中执行） */
export async function getStore<T = any>(
  browser: Browser,
  name: string
): Promise<T> {
  return browser.execute((storeName: string) => {
    // @ts-ignore
    const pinia = window.__pinia__;
    if (!pinia) throw new Error("Pinia not exposed on window.__pinia__");
    const store = pinia._s.get(storeName);
    if (!store) throw new Error(`Store '${storeName}' not found`);
    return store;
  }, name);
}

/** 通过 workspace store 直接打开工作区（绕过原生对话框） */
export async function openWorkspace(
  browser: Browser,
  path: string
): Promise<void> {
  // 注意：browser.execute 在 Tauri WebView2 下不等待 async function 的 Promise
  // 改用 executeAsync，通过 done callback 显式等待异步操作完成
  await browser.executeAsync((wsPath: string, done: (res: unknown) => void) => {
    // @ts-ignore
    const pinia = window.__pinia__;
    const workspace = pinia._s.get("workspace");
    Promise.resolve(workspace.openWorkspace(wsPath))
      .then(() => done(null))
      .catch((err: unknown) => done(err ? String(err) : null));
  }, path);
}

/** 关闭工作区 */
export async function closeWorkspace(browser: Browser): Promise<void> {
  await browser.executeAsync((done: (res: unknown) => void) => {
    // @ts-ignore
    const pinia = window.__pinia__;
    const workspace = pinia._s.get("workspace");
    Promise.resolve(workspace.closeWorkspace())
      .then(() => done(null))
      .catch((err: unknown) => done(err ? String(err) : null));
  });
}

/** 通过 tabs store 打开文件到新 tab（绕过文件树点击） */
export async function openFileInTab(
  browser: Browser,
  path: string
): Promise<void> {
  await browser.executeAsync((filePath: string, done: (res: unknown) => void) => {
    // @ts-ignore
    const pinia = window.__pinia__;
    const tabs = pinia._s.get("tabs");
    Promise.resolve(tabs.openFile(filePath))
      .then(() => done(null))
      .catch((err: unknown) => done(err ? String(err) : null));
  }, path);
}

export interface TabSnapshot {
  id: string;
  path: string | null;
  isDirty: boolean;
  title: string;
  contentLength: number;
}

/** 获取当前 tabs 状态快照 */
export async function getTabsState(
  browser: Browser
): Promise<{ tabs: TabSnapshot[]; activeTabId: string | null }> {
  return browser.execute(() => {
    // @ts-ignore
    const pinia = window.__pinia__;
    const tabs = pinia._s.get("tabs");
    return {
      tabs: tabs.tabs.map((t: any) => ({
        id: t.id,
        path: t.path,
        isDirty: t.isDirty,
        title: t.title ?? (t.path ? t.path.split(/[\\/]/).pop() : "未命名"),
        contentLength: (t.content ?? "").length
      })),
      activeTabId: tabs.activeTabId
    };
  });
}

/** 获取当前激活 tab 的内容（用于断言编辑器内容） */
export async function getActiveContent(browser: Browser): Promise<string> {
  return browser.execute(() => {
    // @ts-ignore
    const pinia = window.__pinia__;
    const tabs = pinia._s.get("tabs");
    return tabs.activeTab?.content ?? "";
  });
}

/** 设置当前激活 tab 的内容（用于断言保存行为） */
export async function setActiveContent(
  browser: Browser,
  content: string
): Promise<void> {
  await browser.execute((newContent: string) => {
    // @ts-ignore
    const pinia = window.__pinia__;
    const tabs = pinia._s.get("tabs");
    if (tabs.activeTab) {
      tabs.updateContent(tabs.activeTab.id, newContent);
    }
  }, content);
}

/** 获取当前主题 */
export async function getCurrentTheme(browser: Browser): Promise<string> {
  return browser.execute(() => {
    // @ts-ignore
    const pinia = window.__pinia__;
    const persistence = pinia._s.get("persistence");
    return persistence?.settings?.markdownTheme ?? null;
  });
}

/**
 * 通过 Tauri event API 触发 menu-event（模拟用户点击原生菜单）
 * 走真实代码路径：App.vue listen -> handleMenuEvent
 */
export async function emitMenuEvent(
  browser: Browser,
  menuId: string
): Promise<void> {
  await browser.executeAsync((id: string, done: (res: unknown) => void) => {
    // @ts-ignore
    window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "menu-event",
      payload: id
    }).then(
      () => done(null),
      (err: unknown) => done(err ? String(err) : null)
    );
  }, menuId);
}
