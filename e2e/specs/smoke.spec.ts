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
    //
    // 失败诊断（#300）：这条前置条件在 CI 上偶发超时，而本地全量、以及按 CI 的真实
    // 顺序（spec 文件大小降序）重放「前一个 spec 到 smoke」的窗口，都复现不了 ——
    // 只报一句「最后一次：tabs 未清空」看不出卡在哪。故把每轮的关键状态累积下来，
    // 超时时一并抛出：轮数与清理耗时、清理是否抛错、tabs 快照、启动恢复是否仍在飞、
    // 是否有 dialog 排队、以及 waitUntil 被拒的原始原因（超时 or 某轮命令抛错）。
    const diag = {
      reason: "（未进入轮询）",
      iterations: 0,
      cleanupMs: 0,
      cleanupError: "（本轮未抛错）",
      tabs: "（未取到）",
      restoring: "（未取到）",
      dialogs: "（未取到）",
      rejectReason: "（无）",
    };

    const waitStartedAt = Date.now();
    try {
      await browser.waitUntil(async () => {
        diag.iterations += 1;

        const cleanupStartedAt = Date.now();
        try {
          await closeAllTabs(browser);
          await closeWorkspace(browser);
          diag.cleanupError = "（本轮未抛错）";
        } catch (err) {
          // 不再静默吞掉：清场失败本身就是最关键的诊断信息（#290）
          diag.cleanupError = err instanceof Error ? err.message : String(err);
          console.warn("[smoke] 前置清理失败:", err);
        }
        diag.cleanupMs = Date.now() - cleanupStartedAt;

        const snap = await browser.execute(() => {
          // @ts-ignore
          const pinia = window.__pinia__;
          const tabsStore = pinia._s.get("tabs");
          const dialogStore = pinia._s.get("dialog");
          return {
            count: tabsStore.tabs.length,
            // 只留前 5 个，避免错误信息过长；content 只取长度（可能很大）
            items: tabsStore.tabs.slice(0, 5).map((t: any) => ({
              path: t.path,
              isDirty: t.isDirty,
              hasExternalChange: t.hasExternalChange,
              contentLength: typeof t.content === "string" ? t.content.length : -1,
            })),
            restoring: tabsStore.restoring === true,
            queuedDialogs: dialogStore?.queue?.length ?? 0,
          };
        });
        diag.tabs = `count=${snap.count} items=${JSON.stringify(snap.items)}`;
        diag.restoring = String(snap.restoring);
        diag.dialogs = String(snap.queuedDialogs);

        if (snap.count !== 0) {
          diag.reason = "tabs 未清空";
          return false;
        }
        const hasWelcome = await browser.$(".welcome-page").isExisting();
        if (!hasWelcome) {
          diag.reason = "tabs 已空但欢迎页不在 DOM";
          return false;
        }
        return true;
      }, { timeout: 20000 });
    } catch (err) {
      // 两种情况都走到这里：条件轮询到超时，或某一轮回调自身抛错（如驱动命令失败）。
      // 把 reject 原文带上，否则会把后者误读成「一直没等到」。
      diag.rejectReason = err instanceof Error ? err.message : String(err);
      throw new Error(
        "smoke 前置条件未就绪\n" +
          `  最后一次卡在：${diag.reason}\n` +
          `  实际耗时：${Date.now() - waitStartedAt}ms（预算 20000ms）\n` +
          `  轮数：${diag.iterations}（最后一轮清理耗时 ${diag.cleanupMs}ms）\n` +
          `  清理抛错：${diag.cleanupError}\n` +
          `  tabs：${diag.tabs}\n` +
          `  启动恢复仍在进行：${diag.restoring}\n` +
          `  排队中的 dialog 数：${diag.dialogs}\n` +
          `  waitUntil 被拒原因：${diag.rejectReason}`
      );
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
