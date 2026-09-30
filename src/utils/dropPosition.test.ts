/**
 * 拖放落点换算测试（issue #288 / #344）
 *
 * `toViewportCoords` 是纯函数：把 Tauri 给的窗口物理像素落点换算成 CodeMirror
 * `posAtCoords` 需要的视口 CSS 像素；换算不出时返回 null（调用方回退光标）。
 *
 * 口径（#344）：Tauri 的 `position` 已经过 wry 的 `ScreenToClient`，是**相对 webview
 * 客户区**的物理像素 —— 与 `clientX/clientY` 同源，只差一次 DPR 折算，**不再减窗口装饰**。
 */
import { describe, it, expect } from "vitest";
import { toViewportCoords } from "./dropPosition";

describe("toViewportCoords", () => {
  it("DPR=1 时原样返回（不再减任何窗口装饰偏移）", () => {
    expect(toViewportCoords({ x: 200, y: 200 }, 1)).toEqual({ x: 200, y: 200 });
  });

  it("DPR>1 时折成 CSS 像素", () => {
    expect(toViewportCoords({ x: 400, y: 400 }, 2)).toEqual({ x: 200, y: 200 });
    expect(toViewportCoords({ x: 300, y: 150 }, 1.5)).toEqual({ x: 200, y: 100 });
  });

  it("DPR 非法（0 / NaN / 负数）时按 1 处理", () => {
    expect(toViewportCoords({ x: 200, y: 200 }, 0)).toEqual({ x: 200, y: 200 });
    expect(toViewportCoords({ x: 200, y: 200 }, Number.NaN)).toEqual({ x: 200, y: 200 });
    expect(toViewportCoords({ x: 200, y: 200 }, -3)).toEqual({ x: 200, y: 200 });
  });

  it("缺省 / NaN / Infinity / 负值 → null（回退光标）", () => {
    expect(toViewportCoords(null, 1)).toBeNull();
    expect(toViewportCoords(undefined, 1)).toBeNull();
    expect(toViewportCoords({ x: Number.NaN, y: 200 }, 1)).toBeNull();
    expect(toViewportCoords({ x: 200, y: Number.POSITIVE_INFINITY }, 1)).toBeNull();
    expect(toViewportCoords({ x: -1, y: 200 }, 1)).toBeNull();
    expect(toViewportCoords({ x: 200, y: -1 }, 1)).toBeNull();
  });

  it("坐标 0 是合法落点（贴近内容区左上角；issue #288 审查）", () => {
    expect(toViewportCoords({ x: 0, y: 0 }, 1)).toEqual({ x: 0, y: 0 });
    expect(toViewportCoords({ x: 1, y: 1 }, 1)).toEqual({ x: 1, y: 1 });
  });

  it("贴近内容区左上角的小坐标不再被误判为无效（#344 的关键回归点）", () => {
    // 旧实现默认减 (8, 31)：y=10 会变成 -21 → 判为非法 → 回退插入光标。
    // 现在应当原样折算（DPR=2 时折半）。
    expect(toViewportCoords({ x: 4, y: 10 }, 1)).toEqual({ x: 4, y: 10 });
    expect(toViewportCoords({ x: 4, y: 10 }, 2)).toEqual({ x: 2, y: 5 });
  });
});
