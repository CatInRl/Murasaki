import { describe, it, expect } from "vitest";
import { MAIN_WINDOW_LABEL, isMainWindow, tabsStoreKey } from "./windowContext";

/**
 * 多窗口标签恢复策略（#442 / ADR-0018）：
 * - 每个窗口按自己的 label 分槽保存标签，互不覆盖；
 * - 只有主窗口在下次启动时恢复；其它窗口是临时会话，不参与自动恢复。
 *   这里只覆盖「分槽 + 主窗口判定」两个纯函数，恢复流程由启动编排保证。
 */
describe("windowContext 多窗口会话分片", () => {
  it("主窗口 label 固定为 main", () => {
    expect(MAIN_WINDOW_LABEL).toBe("main");
  });

  it("主窗口沿用历史的 state key（旧 tabs.json 无需迁移）", () => {
    expect(tabsStoreKey("main")).toBe("state");
  });

  it("其它窗口按 label 分槽，互不覆盖", () => {
    expect(tabsStoreKey("win-1")).toBe("state:win-1");
    expect(tabsStoreKey("win-2")).toBe("state:win-2");
  });

  it("只有主窗口参与启动恢复", () => {
    expect(isMainWindow("main")).toBe(true);
    expect(isMainWindow("win-1")).toBe(false);
  });
});
