/**
 * 元素「已渲染」判定与等待 helper
 *
 * 背景（tauri-driver + msedgedriver 环境实测）：
 * - **元素等待命令不重试**：`waitForExist({ timeout: 15000 })` 对不存在的元素会在
 *   **~10ms 内**直接抛错（错误文案却写「after 15000ms」，纯属文案），实测见 #266。
 *   即「等元素出现」在本栈下是单次判定，本地跑得快所以一直没暴露，CI 慢就成片失败。
 * - `browser.waitUntil` **只有拿到数字型的 `interval` 才会重试**（#300）。实测条件恒返回
 *   false 时：`{ timeout: 20000 }` → **1 次，0–15ms** 就抛
 *   `waitUntil condition timed out after 20000ms`（耗时是假的）；
 *   `{ timeout: 20000, interval: 200 }` → 101 次 / 20008ms。
 *   机制（node_modules/webdriverio/build/index.js:6435-6448）：`waitUntil` 先按解构默认值取
 *   `this.options.waitforInterval`，再用 `typeof interval !== "number"` 兜一次；两者都取不到
 *   数时 interval 是 NaN，Timer 首轮就判超时。而本仓库的 session 由 `attach()` 复用、
 *   **不合并 `remote()` 的默认配置**，`waitforInterval` 正是 undefined。（此前这里写
 *   「waitUntil 正常重试」是错的：当年那次实测带了 `interval 300ms`，结论被过度外推了。）
 *   现在 `helpers/driver.ts` 的 `createSession` 会给 session options 补
 *   `waitforInterval` / `waitforTimeout` 默认值，所以只写 `{ timeout }` 也照常轮询；
 *   但**不要绕过 `createSession` 自建 session**，否则又退回单次判定。
 *   这里仍统一用手写轮询（`browser.execute` + `browser.pause`），不依赖这套默认值。
 * - **带动画的浮层（右键菜单等）用 `waitForPresent`，不要用 `waitForRendered`**：后者把
 *   `opacity: "0"` 判为「未渲染」，而淡入浮层（`opacity 0 → 1`）在过渡进行中就是这个值；
 *   CI runner 上窗口未重绘时 CSS 过渡甚至可能完全不推进，于是每次都判 false、直到超时
 *   （#273 实测偶发：同一个菜单，用 `waitForPresent` 的 spec 稳定通过，用 `waitForRendered`
 *   的间歇性失败）。浮层类断言「存在」+ 读元素内容即可，别判几何/透明度。
 * - `isDisplayed()` / `waitForDisplayed()` 会误判：实测 toast 元素 `display:flex`、
 *   `visibility:visible`、`getBoundingClientRect()` 为 138x42、且 store 中确实存在时，
 *   `isDisplayed()` 仍返回 `false`；`waitForDisplayed()` 在元素/菜单入场动画
 *   （`opacity 0 → 1`）阶段会直接超时报 `still not displayed`。该误判是**持久性**的
 *   （重试救不回来，实测 `smoke.spec.ts` 的 `beforeEach` 因此空等 15s 超时，见 #284），
 *   故 **e2e 里不再使用这两个 API**：要判「可见/已渲染」一律用本文件的 `isRendered`
 *   （按选择器）/ `isRenderedElement`（按元素句柄）。浮层是例外——右键菜单之类的浮层
 *   只判「存在」（`waitForPresent`）并读内容，不判几何与透明度，理由见上一条。
 * - `getText()` 会返回空串：实测 `.dialog-message` 的 `textContent` 是「第一个」时
 *   `getText()` 返回 `''`（`.murasaki-context-menu-shortcut` 首个元素同样如此）。
 * - **元素句柄要「等到了再取」**：`browser.$()` 对不存在的元素**不抛错**，返回的句柄
 *   `elementId` 是 undefined；拿它去 `browser.execute`（`isRenderedElement` / `textOfElement`）
 *   才抛 `The element with selector "..." ... wasn't found`。所以「先取句柄 → `waitForPresent`
 *   → 对那个旧句柄断言」是死路：等待那一步白做，首次查询早于渲染就必挂（#320，
 *   `file-operations.spec.ts` 与 `smoke.spec.ts` 各中一处，都是 #284 收尾留下的）。
 *   要判「已渲染」就每轮重新取句柄（`waitForRendered` 已按这个改法实现），
 *   或直接用按选择器的 `isRendered`。
 *
 * 因此这里不使用 WebDriver 的等待/可见性 API：几何与样式判定在浏览器上下文里用
 * `getBoundingClientRect()` + `getComputedStyle`（`renderedCheck`，由 `isRendered` 按
 * **选择器**、`isRenderedElement` 按**句柄**、`waitForRendered` 按选择器轮询共用）；
 * `waitForPresent` / `waitForAbsent` 则由我们**自己**按间隔调 `browser.$().isExisting()`
 * 轮询（用的是 WebDriver 元素 API，但轮询控制权在我们手里，不依赖它的等待命令是否重试）。
 */
import type { Browser } from "webdriverio";

/**
 * 「已渲染」判定的**单一实现**（在浏览器上下文执行），入参是选择器字符串或元素句柄。
 *
 * `browser.execute` 会把函数序列化后在页面里跑，函数体里引用不到模块作用域，
 * 所以这段几何/样式判定只能写一次，由 `isRendered` 与 `isRenderedElement` 共用（#284）。
 */
async function renderedCheck(browser: Browser, target: unknown): Promise<boolean> {
  return await browser.execute(
    (t: unknown) => {
      // 选择器字符串 → 取首个匹配；元素句柄 → webdriverio 已还原成 DOM 节点
      const el = (typeof t === "string" ? document.querySelector(t) : t) as HTMLElement | null;
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = getComputedStyle(el);
      if (style.display === "none") return false;
      if (style.visibility === "hidden") return false;
      if (style.opacity === "0") return false;
      return true;
    },
    target
  );
}

/**
 * 判断某选择器的首个元素是否「已渲染」：存在 + 非零尺寸 + 未被隐藏（display/visibility/opacity）
 */
export async function isRendered(
  browser: Browser,
  selector: string
): Promise<boolean> {
  return await renderedCheck(browser, selector);
}

/**
 * 判断某个**元素句柄**是否「已渲染」（判定口径与 `isRendered` 完全一致）。
 *
 * 用于选择器没法用 CSS 表达的句柄（文本选择器如 `.action-label=打开文件夹`、
 * XPath 取到的节点）：webdriverio 会把句柄序列化成 WebElement 引用传进页面。
 */
export async function isRenderedElement(
  browser: Browser,
  element: unknown
): Promise<boolean> {
  return await renderedCheck(browser, element);
}

/**
 * 轮询等待元素「已渲染」，超时抛错（错误信息带选择器与超时时间）
 *
 * 轮询间隔 100ms；不使用元素等待命令（`waitForExist` 等在本栈下不重试，见文件头注释）。
 *
 * 每轮**重新取句柄**（`browser.$(selector)`）再判定，这一点有两个作用：
 * - 吃下 WebDriver 才认的选择器 —— XPath（`//div[...]`）与文本选择器（`.cls=文本`）没法交给
 *   页面里的 `document.querySelector`（`isRendered` 走的就是它）；
 * - 避开「先取句柄、再等出现、然后对那个旧句柄断言」的死路（#320）：`browser.$()` 在元素
 *   不存在时**不抛错**，只返回一个 `elementId` 为 undefined 的句柄，拿它去 `execute` 才抛
 *   `wasn't found` —— 于是「等待」那一步白做，首次查询早于渲染就必挂。
 *   故先 `isExisting()` 过一道（对不存在的句柄返回 false 而不抛），确认存在才交给
 *   `isRenderedElement`。
 */
export async function waitForRendered(
  browser: Browser,
  selector: string,
  timeout = 5000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = await browser.$(selector);
    if ((await el.isExisting()) && (await isRenderedElement(browser, el))) return;
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
 * 取元素文本的**单一实现**（浏览器上下文，单次）：选择器字符串或元素句柄 → `textContent.trim()`。
 *
 * `getText()` 在本栈下会对某些元素返回空串（见文件头注释），故一律走这里；
 * `textOfElement`（句柄，单次）与 `readText`（选择器，轮询）都建立在它之上。
 */
async function textFrom(browser: Browser, target: unknown): Promise<string> {
  return await browser.execute((t: unknown) => {
    const el = (typeof t === "string" ? document.querySelector(t) : t) as HTMLElement | null;
    return (el?.textContent ?? "").trim();
  }, target);
}

/**
 * 读某个**元素句柄**的文本（单次，不轮询）。
 *
 * 用于对 `browser.$$(...)` 逐个读句柄的场景（收集标签数组、按文本找按钮等）——
 * 这类地方给不出「单个选择器」，只能按句柄读，而 `getText()` 会偶发返回空串。
 */
export async function textOfElement(browser: Browser, element: unknown): Promise<string> {
  return await textFrom(browser, element);
}

/**
 * 读元素文本并**轮询**（选择器版）：
 * - 不传 `expected`：轮询到非空，返回该文本；
 * - 传字符串：轮询到 `textContent.trim() === expected`；
 * - 传正则：轮询到 `expected.test(textContent.trim())` —— 用于「文案会变、但只断言其中一段」
 *   的场景（例：演示模式缩放 chip 从 `100%` 变 `110%`，只取首非空会读到旧值）。
 *
 * 三种形态都同时消掉「读到空串」与「读太早读到旧值」两类失败（#282 / #286）。
 * 超时错误里带上最后一次读到的值，便于区分「一直为空」与「文案不对」。
 */
export async function readText(
  browser: Browser,
  selector: string,
  expected?: string | RegExp,
  timeout = 5000,
  interval = 100
): Promise<string> {
  const matches = (text: string): boolean => {
    if (expected === undefined) return text.length > 0;
    return expected instanceof RegExp ? expected.test(text) : text === expected;
  };
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeout) {
    last = await textFrom(browser, selector);
    if (matches(last)) return last;
    await browser.pause(interval);
  }
  const want =
    expected === undefined ? "非空文本" : `"${String(expected)}"`;
  throw new Error(
    `readText: "${selector}" 未在 ${timeout}ms 内变为 ${want}（最后读到：${JSON.stringify(last)}）`
  );
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
