/**
 * 文件树相关的备用 helper（跨 spec 复用）
 *
 * 与 `helpers/wait.ts`（通用元素等待）分开：这里的判定绑定了本应用的文件树 DOM
 * 与 `workspace` store 状态。
 */
import type { Browser } from "webdriverio";
import { waitForInBrowser, waitForRendered } from "./wait";

/**
 * 等文件树「安静下来」：节点已渲染 + 没有进行中的刷新 + 让由此产生的滚动/重排落定。
 *
 * 为什么需要：`ContextMenuContainer` 在 window 上以 **capture 阶段**注册了
 * `scroll` / `resize` 关闭（见 src/components/ContextMenuContainer.vue 的 attachListeners），
 * 而工作区刚打开时「文件监听触发的刷新」与「树/标签栏把目标滚入视区」都可能紧跟着发生 ——
 * 菜单弹出后立刻被收掉，等菜单的断言就会失败。
 *
 * 已知三处同一现象：#273（`context-menu.spec.ts` 的 beforeEach 故意不调 `closeWorkspace`，
 * 避免干扰 Teleport 渲染时机）、`file-operations.spec.ts` 的开菜单用例、
 * `file-tree-keyboard.spec.ts` 的 Shift+F10 偶发等不到菜单（#310）。
 */
export async function waitForTreeSettled(b: Browser): Promise<void> {
  await waitForRendered(b, ".file-tree .node-name", 10000);
  await waitForInBrowser(
    b,
    () => {
      // @ts-ignore
      const ws = window.__pinia__._s.get("workspace");
      return ws.loading === false;
    },
    [],
    { timeout: 10000, interval: 200, message: "文件树刷新结束" }
  );
  // 再留一段安静期：刷新带来的滚动/重排通常在几十毫秒内落定
  await b.pause(600);
}
