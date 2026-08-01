/**
 * 通过 browser.execute 访问前端 Pinia store
 * 依赖 main.ts 中暴露的 window.__pinia__
 */
import type { Browser } from "webdriverio";

/**
 * 等待主窗口加载完成并暴露 __pinia__
 *
 * 关键：webdriverio 9.x 的 waitUntil 与 browser.execute 组合在 tauri-driver 下
 * 行为异常（execute 返回 false 后 waitUntil 不重试），改用手动轮询。
 *
 * 健壮性处理：如果上一次测试遗留了 settings 窗口的 WebView2 状态，新 session
 * 的 active window 可能是 settings 窗口（title = "设置"），且 WebView2 可能在
 * 启动后异步恢复 settings 窗口。解决方案：每次轮询时检查当前 title，若非
 * "Murasaki" 则遍历 handles 切换到主窗口。
 */
export async function waitForPinia(
  browser: Browser,
  timeout = 30000
): Promise<void> {
  const start = Date.now();
  let lastSwitchAttempt = 0;

  while (Date.now() - start < timeout) {
    // 每 2s 或首次：遍历所有 handles，寻找暴露了 __pinia__ 的窗口。
    // 不再依赖 title === "Murasaki"（启动期间 title 可能是 "localhost" 或空），
    // 而是直接在每个 handle 上执行 execute 检测 __pinia__。
    if (Date.now() - lastSwitchAttempt > 2000) {
      lastSwitchAttempt = Date.now();
      try {
        const handles = await browser.getWindowHandles().catch(() => []);
        for (const handle of handles) {
          try {
            await browser.switchToWindow(handle);
            const hasPinia = await browser.execute(() => {
              // @ts-ignore
              return !!(window as any).__pinia__;
            }).catch(() => false);
            if (hasPinia) return;
          } catch {
            // 忽略：该 handle 可能已失效
          }
        }
      } catch {
        // 忽略：切换失败不致命
      }
    }

    const ready = await browser.execute(() => {
      // @ts-ignore
      return !!(window as any).__pinia__;
    });
    if (ready) return;
    await browser.pause(500);
  }
  // 超时：诊断信息
  const title = await browser.getTitle().catch(() => "<unknown>");
  const state = await browser.execute(() => document.readyState).catch(() => "<unknown>");
  const handles = await browser.getWindowHandles().catch(() => []);
  throw new Error(
    `waitForPinia 超时 (${timeout}ms)：__pinia__ 未暴露。` +
    ` title="${title}", readyState="${state}", handles=${handles.length}.` +
    ` 可能原因：上一次测试遗留 WebView2 窗口状态（如 settings 窗口）。`
  );
}

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

/** 关闭所有 tabs（测试隔离用，避免前序测试的 tab 残留导致 sidebar 不消失）
 *  用 doCloseTab 强制关闭，绕过 dirty tab 的 needsConfirm 弹窗。
 *  逐个关闭避免 Promise.all 并发导致 splice 索引错位（dirty tab 在 await invoke
 *  期间数组被其他 close 修改，splice(idx) 删错元素） */
export async function closeAllTabs(browser: Browser): Promise<void> {
  await browser.executeAsync((done: (res: unknown) => void) => {
    // @ts-ignore
    const pinia = window.__pinia__;
    const tabs = pinia._s.get("tabs");
    const ids = tabs.tabs.map((t: any) => t.id);
    // 逐个关闭：reduce 串联 Promise，确保前一个 doCloseTab 完成后再执行下一个
    ids.reduce(
      (p: Promise<unknown>, id: string) =>
        p.then(() => Promise.resolve(tabs.doCloseTab(id))),
      Promise.resolve()
    )
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
 * 确保编辑器处于 split 模式（显示预览面板）。
 *
 * E2E 全量运行时，前序 spec 可能将 editorMode 改为 source/wysiwyg 并持久化，
 * 导致后续 spec 的 .preview-pane 不存在。此 helper 在 beforeAll 中调用，
 * 强制重置为 split 并等待应用生效。
 */
export async function ensureSplitMode(browser: Browser): Promise<void> {
  await browser.executeAsync((done: (res: unknown) => void) => {
    // @ts-ignore
    const pinia = window.__pinia__;
    const persistence = pinia._s.get("persistence");
    Promise.resolve(persistence.updateSettings({ editorMode: "split" }))
      .then(() => done(null))
      .catch((err: unknown) => done(err ? String(err) : null));
  });
  // 等待 editorBridge watch 触发 + 重新渲染
  await browser.pause(500);
}

/**
 * 重置持久化设置到默认值（测试隔离用）。
 *
 * 清理前序 spec 残留的 editorMode / showAgentPanel / sidebarView 等设置，
 * 确保当前 spec 从干净状态开始。
 */
export async function resetPersistenceSettings(browser: Browser): Promise<void> {
  await browser.executeAsync((done: (res: unknown) => void) => {
    // @ts-ignore
    const pinia = window.__pinia__;
    const persistence = pinia._s.get("persistence");
    Promise.resolve(persistence.updateSettings({
      editorMode: "split",
      showAgentPanel: true,
      sidebarView: "files",
      showLineNumbers: true,
      softWrap: true,
    }))
      .then(() => done(null))
      .catch((err: unknown) => done(err ? String(err) : null));
  });
  // 同步 sidebarView ref（App.vue 的本地 ref 不会随 persistence.settings 自动同步，
  // 前序 spec 切到 outline 后必须显式重置回 files，否则 .file-tree 不渲染）
  await browser.execute(() => {
    // @ts-ignore
    if (typeof (window as any).__setSidebarView__ === "function") {
      (window as any).__setSidebarView__("files");
    }
  });
  await browser.pause(300);
}

/**
 * 关闭所有打开的对话框（测试隔离用）。
 *
 * 前序 spec 可能残留未关闭的 dialog（如 unsaved changes / confirm / prompt），
 * dialog-overlay 会遮挡后续测试的点击。此 helper 直接清空 dialog store 的 queue。
 * 同时清理 toast，避免残留吐司遮挡元素。
 */
export async function dismissAllDialogs(browser: Browser): Promise<void> {
  await browser.execute(() => {
    // @ts-ignore
    const pinia = window.__pinia__;
    const dialog = pinia._s.get("dialog");
    if (dialog && dialog.queue) {
      // resolve 所有 pending promise 为 cancel，再清空 queue
      const items = dialog.queue.slice();
      for (const item of items) {
        try {
          switch (item.kind) {
            case "alert": item.resolver(undefined); break;
            case "confirm": item.resolver(false); break;
            case "prompt": item.resolver(null); break;
            case "conflict": item.resolver({ action: "cancel" }); break;
            case "unsaved": item.resolver("cancel"); break;
            default: item.resolver(undefined); break;
          }
        } catch { /* ignore */ }
      }
      dialog.queue.length = 0;
    }
    // 清理 toast
    const toast = pinia._s.get("toast");
    if (toast && toast.items) {
      toast.items.length = 0;
    }
  });
  await browser.pause(150);
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

/**
 * 安全调用 store action 并等待结果。
 *
 * 使用 execute + 轮询模式替代 executeAsync，避免 store action 抛错时
 * WebDriverError 穿透 .catch() 导致 worker 崩溃。
 *
 * 关键修复：store action 失败时，store 内部的 catch 块会调用 console.error()。
 * tauri-driver 捕获 console.error 输出，并在后续每次 execute/sync 调用中
 * 报告为 WebDriverError（"文件已存在" 等错误信息会"污染"整个 session）。
 * 这导致 callStoreAction 无法通过 browser.execute 读取 __testResult。
 *
 * 解决方案：在调用 store action 前覆盖 console.error 为空函数，
 * 在 .then()/.catch() 中恢复原值。这样 tauri-driver 不会捕获到错误输出，
 * 后续 execute 调用不受影响。
 *
 * @param browser webdriverio Browser 实例
 * @param storeName Pinia store 名称（如 "fileOps"、"workspace"）
 * @param actionName store 上的方法名（如 "createFile"、"renamePath"）
 * @param args 传给 action 的参数
 * @returns action 的返回值（序列化后）
 */
export async function callStoreAction<T = any>(
  browser: Browser,
  storeName: string,
  actionName: string,
  ...args: any[]
): Promise<T> {
  // 注入永不 reject 的 wrapper 到 window，避免 async function throw 触发
  // CDP Runtime.exceptionThrown 事件（tauri-driver 会缓存并在每次 execute 中重复报告）
  await browser.execute(() => {
    // @ts-ignore
    window.__callAction = async (
      sName: string,
      aName: string,
      ...rest: any[]
    ): Promise<{ ok: boolean; data?: any; error?: string }> => {
      try {
        // @ts-ignore
        const pinia = window.__pinia__;
        const store = pinia._s.get(sName);
        if (!store || typeof store[aName] !== "function") {
          return { ok: false, error: `store.${sName}.${aName} not found` };
        }
        // 关键：用 await + try/catch，把 reject 转换为正常 return，
        // 防止 unhandledrejection 事件传到 tauri-driver。
        const data = await store[aName](...rest);
        return { ok: true, data };
      } catch (err: any) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    };
  });

  // 启动调用（async wrapper 自身不会 reject，所以 execute 立即返回）
  await browser.execute(
    (sName: string, aName: string, ...rest: any[]) => {
      // @ts-ignore
      const promise = window.__callAction(sName, aName, ...rest);
      // @ts-ignore
      window.__testResult = null;
      promise.then((r: any) => {
        // @ts-ignore
        window.__testResult = r;
      });
      // 不需要 .catch()，wrapper 永不 reject
    },
    storeName,
    actionName,
    ...args
  );

  // 轮询等待结果
  const wrapped: any = await browser.waitUntil(
    async () => {
      const r = await browser.execute(() => {
        // @ts-ignore
        return (window as any).__testResult;
      });
      if (r === null || r === undefined) return false;
      return r;
    },
    { timeout: 15000, interval: 100 }
  );

  if (!wrapped) {
    throw new Error(`store.${storeName}.${actionName} failed (no result)`);
  }
  if (!wrapped.ok) {
    throw new Error(wrapped.error || `store.${storeName}.${actionName} failed`);
  }
  return wrapped.data as T;
}
