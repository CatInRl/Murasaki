/**
 * 元素「已渲染」判定与等待 helper
 *
 * 背景（tauri-driver + msedgedriver 环境实测）：
 * - `isDisplayed()` / `waitForDisplayed()` 会误判：实测 toast 元素 `display:flex`、
 *   `visibility:visible`、`getBoundingClientRect()` 为 138x42、且 store 中确实存在时，
 *   `isDisplayed()` 仍返回 `false`；`waitForDisplayed()` 在元素/菜单入场动画
 *   （`opacity 0 → 1`）阶段会直接超时报 `still not displayed`。
 * - `getText()` 会返回空串：实测 `.dialog-message` 的 `textContent` 是「第一个」时
 *   `getText()` 返回 `''`（`.murasaki-context-menu-shortcut` 首个元素同样如此）。
 *
 * 因此这里不再使用 WebDriver 的可见性 API，改为在浏览器上下文用
 * `getBoundingClientRect()` + `getComputedStyle` 判断「已渲染」。
 */
import type { Browser } from "webdriverio";

/**
 * 判断某选择器的首个元素是否「已渲染」：存在 + 非零尺寸 + 未被隐藏（display/visibility/opacity）
 */
export async function isRendered(
  browser: Browser,
  selector: string
): Promise<boolean> {
  return await browser.execute((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    if (style.display === "none") return false;
    if (style.visibility === "hidden") return false;
    if (style.opacity === "0") return false;
    return true;
  }, selector);
}

/**
 * 轮询等待元素「已渲染」，超时抛错（错误信息带选择器与超时时间）
 *
 * 轮询间隔 100ms；不使用 `browser.waitUntil`（其与 `browser.execute` 组合在
 * tauri-driver 下轮询不可靠），改用手动轮询。
 */
export async function waitForRendered(
  browser: Browser,
  selector: string,
  timeout = 5000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await isRendered(browser, selector)) return;
    await browser.pause(100);
  }
  throw new Error(
    `waitForRendered: "${selector}" still not rendered after ${timeout}ms`
  );
}
