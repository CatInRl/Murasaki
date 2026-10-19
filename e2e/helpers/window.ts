/**
 * 窗口收尾 helper（跨 spec 复用）
 *
 * 背景：每个 spec 都会 `createSession()`，而 tauri-driver 的 session 附着到
 * **当时活动的那个窗口**。若上一个 spec 留下多余窗口（设置窗口、拖拽/打开文件夹
 * 新开的窗口），下一个 session 就可能落到那个窗口上 —— 它没有 `__pinia__`
 * （设置窗口走的是独立的 settings 入口），于是 `waitForPinia` 超时，
 * 报出 `title=""`、`handles=1` 这类看起来毫不相干的错误。
 *
 * 这是「随机失败」里最典型的一类：失败点与真实原因（上一个 spec 没关窗）相距很远。
 */
import type { Browser } from "webdriverio";

/** 判定某个句柄对应的页面是否就是主应用窗口（能读到 Pinia） */
async function isAppWindow(b: Browser): Promise<boolean> {
  try {
    return await b.execute(() => {
      // @ts-ignore: E2E 运行时注入，类型不可静态推导
      const pinia = window.__pinia__;
      return Boolean(pinia && pinia._s);
    });
  } catch {
    return false;
  }
}

/**
 * 关掉除主应用窗口外的所有窗口，并把活动窗口切回主窗口。
 *
 * - 主窗口的判据是「能读到 `__pinia__`」，而不是「第一个句柄」或标题文案 ——
 *   句柄顺序由驱动决定，不可依赖
 * - 找不到任何应用窗口时**什么都不做**：那意味着当前 session 本身已经异常，
 *   交给调用方的就绪检查抛出更有信息量的错误
 * - 幂等：只有一个窗口时直接返回
 */
export async function closeExtraWindows(b: Browser): Promise<void> {
  const handles = await b.getWindowHandles().catch(() => [] as string[]);
  if (handles.length <= 1) return;

  let keep: string | null = null;
  for (const handle of handles) {
    try {
      await b.switchToWindow(handle);
    } catch {
      continue;
    }
    if (await isAppWindow(b)) {
      keep = handle;
      break;
    }
  }
  if (keep === null) {
    // 没有可识别的应用窗口：不擅自关窗（可能把整个应用关掉）
    return;
  }

  for (const handle of handles) {
    if (handle === keep) continue;
    try {
      await b.switchToWindow(handle);
      // close_window 销毁本窗口后 IPC 通道断开，execute 抛错属预期
      await b
        .execute(() => {
          try {
            window.__TAURI_INTERNALS__.invoke("close_window");
          } catch {
            /* ignore */
          }
        })
        .catch(() => {});
    } catch {
      /* ignore */
    }
    await b.pause(300);
  }

  try {
    await b.switchToWindow(keep);
  } catch {
    /* ignore */
  }

  // 等句柄数归一，避免下一个 spec 建 session 时仍看到多余窗口
  for (let i = 0; i < 20; i++) {
    const current = await b.getWindowHandles().catch(() => [] as string[]);
    if (current.length <= 1) return;
    await b.pause(200);
  }
}
