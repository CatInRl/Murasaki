/**
 * 通过 browser.execute 访问前端 Pinia store
 * 依赖 main.ts 中暴露的 window.__pinia__
 */
import type { Browser } from "webdriverio";
import { waitForInBrowser } from "./wait";
import { toAppPath } from "./platform";

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

/**
 * 等应用**初始化完成**（可以开始动手了）。
 *
 * 为什么需要：`App.vue` 的 `onMounted` 里「恢复上次设置 / 工作区 / 标签」是一串 `await`，
 * 而各 spec 建好 session 后**立刻清场**。若清场早于这些恢复落地，恢复会把刚重置的视图 / 标签
 * 又覆盖回去 —— 实测表现为 `.file-tree` 10s 不出现（global-search）、欢迎页不在 DOM（smoke），
 * CI 上约 10% 概率、本地几乎不复现（纯时序，#315）。
 *
 * 判据是 `App.vue` 在 `initialized.value = true` 处挂的 `window.__appReady__` ——
 * 它一定晚于上面那三处恢复。`createSession()` 已调用本函数，各 spec 不必自己等。
 */
export async function waitForAppReady(
  browser: Browser,
  timeout = 30000
): Promise<void> {
  try {
    await waitForInBrowser(
      browser,
      () => !!(window as any).__appReady__,
      [],
      { timeout, interval: 200, message: "应用初始化完成（window.__appReady__）" }
    );
  } catch (err) {
    throw new Error(
      `${String(err)}。可能原因：应用启动恢复（设置 / 工作区 / 标签）卡住，或 onMounted 提前抛错。`
    );
  }
}

/**
 * 只在**当前窗口句柄**内等待 __pinia__，绝不切换句柄。
 *
 * `waitForPinia()` 为了容错会遍历所有句柄并停在第一个暴露 __pinia__ 的窗口 ——
 * 在单窗口场景下没问题，但多窗口场景会把当前句柄**切回主窗口**，导致后续断言读到
 * 主窗口的状态（multi-window.spec 曾因此误判为「新窗口没建出来」）。
 * 切窗之后请用本函数。
 */
export async function waitForPiniaInCurrentWindow(
  browser: Browser,
  timeout = 30000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ready = await browser
      .execute(() => {
        // @ts-ignore
        return !!(window as any).__pinia__;
      })
      .catch(() => false);
    if (ready) return;
    await browser.pause(500);
  }
  // 超时：收集 webview 内的诊断信息（#371）—— console 缓冲由 Rust 侧
  // initialization_script 在任何页面脚本前注入，能反映 __pinia__ 初始化全程
  const title = await browser.getTitle().catch(() => "<unknown>");
  let detail = `title="${title}"`;
  const diag = await browser
    .execute(() => {
      // @ts-ignore
      const buf = (window as any).__murasakiConsoleBuffer__;
      return {
        readyState: document.readyState,
        logs: buf ? buf.slice(-100) : null,
      };
    })
    .catch(() => null);
  if (!diag) {
    detail += "，诊断信息收集失败（execute 抛错，webview 可能已崩溃）";
  } else {
    detail += `，readyState="${diag.readyState}"`;
    if (diag.logs === null) {
      detail += "，__murasakiConsoleBuffer__ 未注入（initialization_script 未生效？）";
    } else if (diag.logs.length > 0) {
      detail +=
        `，webview console（最近 ${diag.logs.length} 条）：\n` +
        diag.logs.map((l: any) => `  [${l.level}] ${l.msg}`).join("\n");
    } else {
      detail += "，webview console 缓冲为空（页面脚本未产生任何输出）";
    }
  }
  throw new Error(
    `waitForPiniaInCurrentWindow 超时 (${timeout}ms)：当前句柄未暴露 __pinia__。${detail}`
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
  }, toAppPath(path));
}

/**
 * 清空标签并**落盘**（跨 spec 泄漏防护，由 `driver.ts` 的 `closeSession` 调用）。
 *
 * 与 `closeAllTabs` 有两处不同：
 * ① 走 `clearAll()` —— 一次性清空，不需要逐个 `doCloseTab`（那会把每个 dirty tab 写成草稿）；
 * ② 显式 `persist()` —— `clearAll()` 只清内存，并且它会把 `restoring` 置 true 让 Vue watcher
 *    跳过 persist；不显式落盘的话 `tabs.json` 里仍是旧内容，等于没清。
 *
 * 应用未就绪（`__pinia__` 不存在）时静默返回：`createSession` 的就绪失败分支也会经
 * `closeSession` 调到这里，那里不该再抛错。
 */
export async function clearPersistedTabs(browser: Browser): Promise<void> {
  await browser.executeAsync((done: (res: unknown) => void) => {
    // @ts-ignore
    const tabs = window.__pinia__?._s?.get("tabs");
    if (!tabs) return done(null);
    tabs.clearAll();
    Promise.resolve(tabs.persist())
      .then(() => done(null))
      .catch(() => done(null));
  });
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
 * 清理前序 spec 残留的 editorMode / sidebarView 等设置，
 * 确保当前 spec 从干净状态开始。
 */
export async function resetPersistenceSettings(browser: Browser): Promise<void> {
  await browser.executeAsync((done: (res: unknown) => void) => {
    // @ts-ignore
    const pinia = window.__pinia__;
    const persistence = pinia._s.get("persistence");
    Promise.resolve(persistence.updateSettings({
      editorMode: "split",
      sidebarView: "files",
      // 侧栏折叠 / 显示隐藏文件也一并复位：目前没有 spec 依赖它们，但漏掉就等于
      // 把「前序 spec 的遗留状态」留给后面的用例（#315）
      sidebarCollapsed: false,
      showHiddenFiles: false,
      showLineNumbers: true,
      softWrap: true,
    }))
      .then(() => done(null))
      .catch((err: unknown) => done(err ? String(err) : null));
  });
  // 同步 sidebarView ref（App.vue 的本地 ref 不会随 persistence.settings 自动同步，
  // 前序 spec 切到 outline 后必须显式重置回 files，否则 .file-tree 不渲染）。
  // 应用就绪（`createSession` 里的 `waitForAppReady`）保证钩子已经挂上；缺了就是时序出了问题 → 直接报错，
  // 不要静默跳过（那会退化成本函数看似成功、后续却等不到 `.file-tree`）。
  await browser.execute(() => {
    // @ts-ignore
    const setSidebarView = (window as any).__setSidebarView__;
    if (typeof setSidebarView !== "function") {
      throw new Error(
        "__setSidebarView__ 未注册：应用似乎还没初始化完成（绕过了 createSession 的 waitForAppReady？）"
      );
    }
    setSidebarView("files");
  });
  // 校验写入确实生效（原先固定 `pause(300)` 只是赌它够，CI 慢一点就把脏状态漏给用例，#315）。
  // 注意这里校验的是 **settings 里的值**；UI 是否真的切回 files 由各 spec 自己等 `.file-tree` 兜住
  // —— 重置时通常还没有工作区，侧栏不渲染，此处无法从 DOM 校验。
  await waitForInBrowser(
    browser,
    () => {
      // @ts-ignore
      const p = window.__pinia__?._s?.get("persistence");
      return p?.settings?.sidebarView === "files";
    },
    [],
    { timeout: 5000, interval: 100, message: "sidebarView 已重置为 files" }
  );
  // 再留一拍让 Vue 把侧栏渲染到 files 视图（渲染是异步的）
  await browser.pause(100);
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
    // 清理 toast（store 暴露的是 toasts 且有 dismissAll；旧写法 `toast.items` 是死代码，
    // 残留的吐司连同其定时器会污染后续用例）
    const toast = pinia._s.get("toast");
    if (toast && typeof toast.dismissAll === "function") {
      toast.dismissAll();
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
