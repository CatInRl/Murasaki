/**
 * Murasaki 启动 smoke 测试
 * 验证：
 * - 应用窗口能启动并显示标题
 * - 欢迎页可见，包含核心入口按钮
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Browser } from "webdriverio";
import { createSession, closeSession } from "../helpers/driver";
import { closeWorkspace, closeAllTabs, waitForPinia } from "../helpers/store";
import { isRenderedElement, readText, waitForPresent, waitForRendered } from "../helpers/wait";

let browser: Browser;

describe("Murasaki 启动 smoke 测试", () => {
  beforeAll(async () => {
    browser = await createSession();
    await waitForPinia(browser);
  }, 60000);

  afterAll(async () => {
    if (browser) await closeSession(browser);
  });

  beforeEach(async () => {
    // 全量 E2E 跑时，前序 spec 持久化了 tabs，新 session 启动时 App.vue 的
    // onMounted 会异步 restore()。该恢复可能晚于本处清理落地，把已回到的欢迎页
    // 再替换掉，因此在轮询里反复清理，直到 tabs 为空且欢迎页已就绪。
    //
    // 「就绪」只看**存在性**，不判可见性/几何：tabs 为空时 App.vue 走 v-else 分支，
    // 欢迎页就是当前视图；而几何判定会受「视图切换那一瞬父容器尺寸为 0」影响 ——
    // #290 实测：换成 isRendered（要求 rect > 0）后 CI 上仍偶发 15s 超时。
    // 超时错误里带上最后一次卡在哪一步，便于下次直接判读。
    let lastReason = "（未进入轮询）";
    try {
      await browser.waitUntil(async () => {
        try {
          await closeAllTabs(browser);
          await closeWorkspace(browser);
        } catch (err) {
          // 不再静默吞掉：清场失败本身就是最关键的诊断信息（#290）
          console.warn("[smoke] 前置清理失败:", err);
        }
        const noTabs = await browser.execute(() => {
          // @ts-ignore
          return window.__pinia__._s.get("tabs").tabs.length === 0;
        });
        if (!noTabs) {
          lastReason = "tabs 未清空";
          return false;
        }
        const hasWelcome = await browser.$(".welcome-page").isExisting();
        if (!hasWelcome) {
          lastReason = "tabs 已空但欢迎页不在 DOM";
          return false;
        }
        return true;
      }, { timeout: 20000 });
    } catch {
      throw new Error(`smoke 前置条件未就绪（最后一次：${lastReason}）`);
    }
  });

  it("窗口标题为 Murasaki", async () => {
    const title = await browser.getTitle();
    expect(title).toBe("Murasaki");
  });

  it("显示欢迎页（.welcome-page 存在且可见）", async () => {
    // 用「轮询到已渲染」代替单次判定：欢迎页没有透明度/位移动画，`waitForRendered`
    // 在这里是安全的（带动画的浮层不能用它，见 AGENTS.md）；且比单次断言更耐 CI 慢，
    // 也不会被「切换那一瞬尺寸为 0」判假（#290）。
    await waitForRendered(browser, ".welcome-page", 15000);
  });

  it("欢迎页包含 'Murasaki' 标题文本", async () => {
    await waitForPresent(browser, ".welcome-page .brand-title", 10000);
    // Vue 异步渲染可能需要额外时间填充文本
    const text = await readText(browser, ".welcome-page .brand-title");
    expect(text).toMatch(/Murasaki/i);
  });

  it("欢迎页提供'打开文件夹'入口", async () => {
    // WelcomePage 用 .action-card > .action-label 结构渲染按钮
    // button=TEXT 选择器只匹配直接文本节点，不匹配嵌套 span，所以用 .action-label
    const label = await browser.$(".action-label=打开文件夹");
    await waitForPresent(browser, ".action-label=打开文件夹", 10000);
    // 元素出现只保证它在 DOM 中，不等同于可见；轮询 isRendered，
    // 避免读到欢迎页切换过程中的瞬时状态（isDisplayed 在本栈下会持久性误判）
    await browser.waitUntil(async () => {
      return await isRenderedElement(browser, label);
    }, { timeout: 5000 });
    expect(await isRenderedElement(browser, label)).toBe(true);
  });

  it("欢迎页提供'打开文件'和'新建文件'入口", async () => {
    const openFile = await browser.$(".action-label=打开文件");
    const newFile = await browser.$(".action-label=新建文件");
    await waitForPresent(browser, ".action-label=打开文件", 10000);
    await waitForPresent(browser, ".action-label=新建文件", 10000);
    expect(await isRenderedElement(browser, openFile)).toBe(true);
    expect(await isRenderedElement(browser, newFile)).toBe(true);
  });
});
