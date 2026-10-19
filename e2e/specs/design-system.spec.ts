/**
 * 设计系统 E2E 测试（议题簇 3 / Ticket #68, #60）
 *
 * **只保留需要真实浏览器样式引擎的项**（#444）：CSS 变量解析、`color-mix()`
 * 求值、`border-style` 计算值 —— 这些在 jsdom 里拿不到（jsdom 不做 CSS 布局与
 * 色彩计算，`getComputedStyle` 对自定义属性与 color-mix 返回空/原值）。
 *
 * 其余 DOM 结构与文案断言已下沉到单测，别再加回来：
 * - `src/components/WelcomePage.test.ts` —— 品牌图标 / 标题 / 三张卡片 / 快捷键提示
 * - `src/components/EmptyState.test.ts` —— 空态图标 / 标题 / 操作按钮 / 事件
 * - `src/components/StatusBar` 相关图标渲染由各组件单测覆盖
 *
 * 通过 Pinia store 模拟状态，验证 UI 渲染。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace, defaultFixtureFiles } from "../helpers/fixtures";
import {
  openWorkspace,
  closeWorkspace,
  openFileInTab,
  closeAllTabs,
  waitForPinia,
  resetPersistenceSettings,
} from "../helpers/store";
import { isRendered, waitForPresent, waitForInBrowser } from "../helpers/wait";
import { toAppPath } from "../helpers/platform";

let browser: Browser;

describe("设计系统", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  beforeEach(async () => {
    await resetPersistenceSettings(browser);
    const wsPath = resetWorkspace(defaultFixtureFiles());
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
    await openWorkspace(browser, wsPath);
    await waitForPresent(browser, ".file-tree", 10000);
  });

  it("--murasaki-primary token 解析为 #9333ea", async () => {
    const color = await browser.execute(() => {
      const root = document.documentElement;
      return window.getComputedStyle(root).getPropertyValue("--murasaki-primary").trim();
    });
    expect(color.toLowerCase()).toBe("#9333ea");
  });

  it("--murasaki-primary-foreground token 解析为 #ffffff", async () => {
    const color = await browser.execute(() => {
      const root = document.documentElement;
      return window.getComputedStyle(root).getPropertyValue("--murasaki-primary-foreground").trim();
    });
    // getComputedStyle 会把 6 位十六进制最短化为 3 位（#ffffff → #fff），
    // 故先把取到的值归一化补齐为 6 位再比较（theme.css 里字面量为 #ffffff）
    const lower = color.toLowerCase();
    const hex = /^#[0-9a-f]{3}$/.test(lower)
      ? `#${lower[1]}${lower[1]}${lower[2]}${lower[2]}${lower[3]}${lower[3]}`
      : lower;
    expect(hex).toBe("#ffffff");
  });

  it("EmptyState 的虚线边框被解析为 dashed", async () => {
    // 需要真实的 CSS 计算：jsdom 的 getComputedStyle 不返回 border-style 的计算值
    const wsPath = resetWorkspace([{ path: "temp.md", content: "# 临时\n" }]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\temp.md`);
    await closeWorkspace(browser);

    await waitForPresent(browser, ".file-tree .empty-state", 10000);
    expect(await isRendered(browser, ".file-tree .empty-state")).toBe(true);

    const borderStyle = await browser.execute(() => {
      const el = document.querySelector(".file-tree .empty-state") as HTMLElement | null;
      if (!el) return "NOT_FOUND";
      return window.getComputedStyle(el).borderStyle;
    });
    expect(borderStyle).toBe("dashed");
  });

  it("文件树选中底色的半透明覆盖层跟随 --murasaki-primary-soft（color-mix 生效）", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openFileInTab(browser, `${wsPath}\\intro.md`);

    // 通过 store 选中节点（与 misc-visual 同一手法）
    await browser.execute(
      (path: string) => {
        // @ts-ignore: E2E 运行时注入，类型不可静态推导
        window.__pinia__._s.get("workspace").selectedFilePath = path;
      },
      toAppPath(`${wsPath}\\intro.md`)
    );
    await waitForPresent(browser, ".file-tree .node-row.is-selected", 10000);

    // 选中底色带 120ms 过渡，读太早会拿到过渡中的中间值；轮询到与
    // --murasaki-primary-soft 的解析值一致再断言（引用关系，改主色自动跟随）
    const result = await waitForInBrowser(
      browser,
      () => {
        const el = document.querySelector(".file-tree .node-row.is-selected") as HTMLElement | null;
        if (!el) return null;
        const probe = document.createElement("div");
        probe.style.backgroundColor = "var(--murasaki-primary-soft)";
        document.body.appendChild(probe);
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const actual = getComputedStyle(el).backgroundColor;
        if (actual !== expected) return null;
        return { actual, expected, width: el.getBoundingClientRect().width };
      },
      [],
      { message: "选中底色未稳定到 --murasaki-primary-soft", timeout: 10000 }
    );

    expect(result!.width).toBeGreaterThan(0);
    expect(result!.actual).toBe(result!.expected);
    // 半透明（非不透明纯色）：color-mix(..., transparent) 的产物
    expect(result!.actual).not.toMatch(/^rgb\(/);
  });
});
