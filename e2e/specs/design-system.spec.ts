/**
 * 设计系统 E2E 测试（议题簇 3 / Ticket #68, #60）
 *
 * 验证：
 * - --murasaki-primary CSS token 应用
 * - lucide 图标渲染为 inline SVG
 * - 欢迎页视觉：BookOpen 图标 + 品牌标题 + 快捷键提示
 * - EmptyState 组件：无工作区时文件树显示空状态
 * - EmptyState 虚线边框容器样式
 *
 * 通过 Pinia store 模拟状态，验证 UI 渲染。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { resetWorkspace, defaultFixtureFiles } from "../helpers/fixtures";
import { openWorkspace, closeWorkspace, openFileInTab, closeAllTabs, waitForPinia, resetPersistenceSettings } from "../helpers/store";
import { isRendered, readText, textOfElement, waitForPresent, waitForInBrowser } from "../helpers/wait";
import { IS_MACOS, toAppPath } from "../helpers/platform";

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
    try { await closeAllTabs(browser); } catch { /* ignore */ }
    try { await closeWorkspace(browser); } catch { /* ignore */ }
    // 打开工作区确保 StatusBar / 侧栏等 DOM 稳定渲染
    // （前序 spec 可能将 statusBarVisible 切换为 false，打开工作区不直接重置它，
    //  但状态栏内的图标渲染依赖 StatusBar 组件挂载，配合下方 waitUntil 保证存在）
    await openWorkspace(browser, wsPath);
    await waitForPresent(browser, ".file-tree", 10000);
    // 显式恢复状态栏可见（前序 spec 的 Alt+Shift+S 可能隐藏状态栏且未恢复）
    await browser.execute(() => {
      // @ts-ignore
      const pinia = window.__pinia__;
      // 状态栏显隐通过 keydown 切换；这里通过派发 Alt+Shift+S 让 App.vue 重置
      // 但若已可见则不要再切，先检测 .status-bar 是否存在
      if (!document.querySelector(".status-bar")) {
        const ev = new KeyboardEvent("keydown", {
          key: "s", bubbles: true, cancelable: true,
          altKey: true, shiftKey: true,
        });
        window.dispatchEvent(ev);
      }
    });
    await browser.pause(150);
    // 等待状态栏出现（若已被隐藏）
    await waitForPresent(browser, ".status-bar", 5000);
  });

  it("--murasaki-primary token 解析为 #9333ea", async () => {
    // 检查 :root 上的 --murasaki-primary 是否被正确解析
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

  it("lucide 图标渲染为 inline SVG", async () => {
    // 状态栏的 FileText 图标应渲染为 <svg>
    await waitForPresent(browser, ".status-bar", 10000);

    const svgCount = await browser.execute(() => {
      const icons = document.querySelectorAll(".status-bar .status-icon");
      return Array.from(icons).filter((el) => el.tagName.toLowerCase() === "svg").length;
    });
    expect(svgCount).toBeGreaterThan(0);
  });

  it("欢迎页显示 BookOpen 图标 SVG", async () => {
    await waitForPresent(browser, ".welcome-page", 10000);

    // .brand-mark 内应有一个 SVG（BookOpen 图标）
    const brandSvg = await browser.execute(() => {
      const mark = document.querySelector(".welcome-page .brand-mark svg");
      return mark ? true : false;
    });
    expect(brandSvg).toBe(true);
  });

  it("欢迎页显示品牌标题 Murasaki", async () => {
    await waitForPresent(browser, ".welcome-page .brand-title", 10000);
    expect(await readText(browser, ".welcome-page .brand-title", "Murasaki")).toBe("Murasaki");
  });

  it("欢迎页显示三张操作卡片", async () => {
    const cards = await browser.$$(".welcome-page .action-card");
    expect(cards.length).toBe(3);
  });

  it("欢迎页显示快捷键提示", async () => {
    const hints = await browser.$$(".welcome-page .shortcut-hint");
    expect(hints.length).toBeGreaterThanOrEqual(3);

    // macOS 按 #341 的平台转换显示 ⌘ 变体，期望值按平台取
    const expectKey = (win: string, mac: string) => (IS_MACOS ? mac : win);
    const hintTexts: string[] = [];
    for (let i = 0; i < hints.length; i++) {
      const kbd = await hints[i].$(".shortcut-key");
      hintTexts.push(await textOfElement(browser, kbd));
    }
    expect(hintTexts).toContain(expectKey("Ctrl+O", "⌘+O"));
    expect(hintTexts).toContain(expectKey("Ctrl+N", "⌘+N"));
    expect(hintTexts).toContain(expectKey("Ctrl+Shift+O", "⌘+Shift+O"));
  });

  it("无工作区时文件树显示 EmptyState", async () => {
    // 侧边栏仅在 hasWorkspace || hasTabs 时渲染。
    // 先打开工作区 + 文件（创建 tab），再关闭工作区 → 侧边栏仍可见，
    // FileTree 因 !hasWorkspace 显示 EmptyState。
    const wsPath = resetWorkspace([
      { path: "temp.md", content: "# 临时\n" },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\temp.md`);
    await closeWorkspace(browser);
    // 等待 sidebar 切换到 EmptyState
    await browser.pause(500);

    await waitForPresent(browser, ".file-tree .empty-state", 10000);
    // isDisplayed() 在本栈下会持久性误判（见 helpers/wait.ts 头部），改用 isRendered
    expect(await isRendered(browser, ".file-tree .empty-state")).toBe(true);

    expect(await readText(browser, ".file-tree .empty-state .empty-title", "未打开工作区")).toBe("未打开工作区");
  });

  it("EmptyState 有虚线边框", async () => {
    const wsPath = resetWorkspace([
      { path: "temp.md", content: "# 临时\n" },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\temp.md`);
    await closeWorkspace(browser);
    await browser.pause(500);

    await waitForPresent(browser, ".file-tree .empty-state", 10000);

    const borderStyle = await browser.execute(() => {
      const el = document.querySelector(".file-tree .empty-state") as HTMLElement | null;
      if (!el) return "NOT_FOUND";
      return window.getComputedStyle(el).borderStyle;
    });
    expect(borderStyle).toBe("dashed");
  });

  it("EmptyState 有操作按钮", async () => {
    const wsPath = resetWorkspace([
      { path: "temp.md", content: "# 临时\n" },
    ]);
    await openWorkspace(browser, wsPath);
    await openFileInTab(browser, `${wsPath}\\temp.md`);
    await closeWorkspace(browser);
    await browser.pause(500);

    await waitForPresent(browser, ".file-tree .empty-state .empty-action", 10000);
    expect(await isRendered(browser, ".file-tree .empty-state .empty-action")).toBe(true);
    expect(await readText(browser, ".file-tree .empty-state .empty-action", "打开文件夹")).toBe("打开文件夹");
  });

  it("文件树选中底色的半透明覆盖层跟随 --murasaki-primary-soft（color-mix 生效）", async () => {
    const wsPath = resetWorkspace(defaultFixtureFiles());
    await openFileInTab(browser, `${wsPath}\\intro.md`);
    await browser.pause(500);

    // 通过 store 选中节点（与 misc-visual 同一手法）
    await browser.execute((path: string) => {
      // @ts-ignore
      window.__pinia__._s.get("workspace").selectedFilePath = path;
    }, toAppPath(`${wsPath}\\intro.md`));
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
