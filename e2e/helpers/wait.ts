/**
 * 元素「已渲染」判定与等待 helper
 *
 * 背景（tauri-driver + msedgedriver 环境实测）：
 * - **元素等待命令不重试**：`waitForExist({ timeout: 15000 })` 对不存在的元素会在
 *   **~10ms 内**直接抛错（错误文案却写「after 15000ms」，纯属文案），实测见 #266。
 *   即「等元素出现」在本栈下是单次判定，本地跑得快所以一直没暴露，CI 慢就成片失败。
 * - `browser.waitUntil` 本身**正常重试**（实测 5s / interval 300ms → 轮询 17 次），
 *   但它的条件函数要读应用状态就得用 `browser.execute`，而这里需要按选择器判定，
 *   于是统一改成手写轮询（`browser.execute` + `browser.pause`），不依赖两者行为。
 * - **带动画的浮层（右键菜单等）用 `waitForPresent`，不要用 `waitForRendered`**：后者把
 *   `opacity: "0"` 判为「未渲染」，而淡入浮层（`opacity 0 → 1`）在过渡进行中就是这个值；
 *   CI runner 上窗口未重绘时 CSS 过渡甚至可能完全不推进，于是每次都判 false、直到超时
 *   （#273 实测偶发：同一个菜单，用 `waitForPresent` 的 spec 稳定通过，用 `waitForRendered`
 *   的间歇性失败）。浮层类断言「存在」+ 读元素内容即可，别判几何/透明度。
 * - `isDisplayed()` / `waitForDisplayed()` 会误判：实测 toast 元素 `display:flex`、
 *   `visibility:visible`、`getBoundingClientRect()` 为 138x42、且 store 中确实存在时，
 *   `isDisplayed()` 仍返回 `false`；`waitForDisplayed()` 在元素/菜单入场动画
 *   （`opacity 0 → 1`）阶段会直接超时报 `still not displayed`。
 * - `getText()` 会返回空串：实测 `.dialog-message` 的 `textContent` 是「第一个」时
 *   `getText()` 返回 `''`（`.murasaki-context-menu-shortcut` 首个元素同样如此）。
 *
 * 因此这里不使用 WebDriver 的等待/可见性 API：`isRendered` / `waitForRendered` 在浏览器
 * 上下文用 `getBoundingClientRect()` + `getComputedStyle` 判定「已渲染」；`waitForPresent`
 * / `waitForAbsent` 则由我们**自己**按间隔调 `browser.$().isExisting()` 轮询（用的是
 * WebDriver 元素 API，但轮询控制权在我们手里，不依赖它的等待命令是否重试）。
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
 * 轮询间隔 100ms；不使用元素等待命令（`waitForExist` 等在本栈下不重试，见文件头注释）。
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

/**
 * 手写轮询等待「选择器命中」（元素出现），超时抛错。
 *
 * 替代 `el.waitForExist({ timeout })` —— 后者在本栈下不重试（见文件头注释），
 * 只在「检查时元素恰好已经在」时才碰巧通过。
 */
export async function waitForPresent(
  browser: Browser,
  selector: string,
  timeout = 15000,
  interval = 150
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await browser.$(selector).isExisting()) return;
    await browser.pause(interval);
  }
  throw new Error(`waitForPresent: "${selector}" 未在 ${timeout}ms 内出现`);
}

/** 手写轮询等待「选择器不再命中」（元素消失）；替代 `el.waitForExist({ reverse: true })` */
export async function waitForAbsent(
  browser: Browser,
  selector: string,
  timeout = 15000,
  interval = 150
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (!(await browser.$(selector).isExisting())) return;
    await browser.pause(interval);
  }
  throw new Error(`waitForAbsent: "${selector}" 未在 ${timeout}ms 内消失`);
}

/**
 * 手写轮询等待「浏览器上下文里返回真值的条件」，返回首次为真的结果。
 *
 * 用于等 UI 状态出现（如「tab 栏出现名为 intro.md 的标签」）：这类断言不能用
 * 元素等待命令 —— 它们在本栈下不重试（见文件头注释），CI 上必然翻车。
 *
 * @param script 在浏览器上下文执行的函数（同 `browser.execute` 的第一个参数）
 * @param args 传给 script 的参数
 * @param options.timeout 总预算；默认 15s（CI runner 比本地慢，别给太紧）
 * @param options.interval 轮询间隔
 * @param options.message 超时错误里的描述，便于定位是哪一步没等到
 */
export async function waitForInBrowser<T = unknown>(
  browser: Browser,
  script: string | ((...args: never[]) => T),
  args: unknown[] = [],
  options: { timeout?: number; interval?: number; message?: string } = {}
): Promise<T> {
  const { timeout = 15000, interval = 200, message = "条件" } = options;
  const start = Date.now();
  let last: unknown = undefined;
  while (Date.now() - start < timeout) {
    last = await browser.execute(script as never, ...(args as never[]));
    if (last) return last as T;
    await browser.pause(interval);
  }
  throw new Error(
    `waitForInBrowser: ${message} 未在 ${timeout}ms 内满足（最后一次结果：${JSON.stringify(last)}）`
  );
}
