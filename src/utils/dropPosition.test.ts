/**
 * 拖放落点换算测试（issue #288）
 *
 * `toViewportCoords` 是纯函数：把 Tauri 给的窗口物理像素落点换算成 CodeMirror
 * `posAtCoords` 需要的视口 CSS 像素；换算不出时返回 null（调用方回退光标）。
 */
import { describe, it, expect } from "vitest";
import {
  toViewportCoords,
  WINDOW_DECORATION_OFFSET_X,
  WINDOW_DECORATION_OFFSET_Y,
} from "./dropPosition";

describe("toViewportCoords", () => {
  it("DPR=1 时按装饰偏移平移", () => {
    expect(toViewportCoords({ x: 200, y: 200 }, 1)).toEqual({
      x: 200 - WINDOW_DECORATION_OFFSET_X,
      y: 200 - WINDOW_DECORATION_OFFSET_Y,
    });
  });

  it("DPR>1 时先折成 CSS 像素再减装饰偏移", () => {
    expect(toViewportCoords({ x: 400, y: 400 }, 2)).toEqual({
      x: 200 - WINDOW_DECORATION_OFFSET_X,
      y: 200 - WINDOW_DECORATION_OFFSET_Y,
    });
  });

  it("DPR 非法（0 / NaN / 负数）时按 1 处理", () => {
    const expected = {
      x: 200 - WINDOW_DECORATION_OFFSET_X,
      y: 200 - WINDOW_DECORATION_OFFSET_Y,
    };
    expect(toViewportCoords({ x: 200, y: 200 }, 0)).toEqual(expected);
    expect(toViewportCoords({ x: 200, y: 200 }, Number.NaN)).toEqual(expected);
    expect(toViewportCoords({ x: 200, y: 200 }, -3)).toEqual(expected);
  });

  it("缺省 / 坐标为 0 / NaN / Infinity → null（回退光标）", () => {
    expect(toViewportCoords(null, 1)).toBeNull();
    expect(toViewportCoords(undefined, 1)).toBeNull();
    expect(toViewportCoords({ x: 0, y: 200 }, 1)).toBeNull();
    expect(toViewportCoords({ x: 200, y: 0 }, 1)).toBeNull();
    expect(toViewportCoords({ x: Number.NaN, y: 200 }, 1)).toBeNull();
    expect(toViewportCoords({ x: 200, y: Number.POSITIVE_INFINITY }, 1)).toBeNull();
  });

  it("减掉装饰偏移后为负 → null（落点在非客户区，视口内无对应位置）", () => {
    expect(toViewportCoords({ x: 4, y: 200 }, 1)).toBeNull();
    expect(toViewportCoords({ x: 200, y: 10 }, 1)).toBeNull();
  });

  it("可传入自定义装饰偏移", () => {
    expect(toViewportCoords({ x: 100, y: 100 }, 1, 0, 0)).toEqual({ x: 100, y: 100 });
    expect(toViewportCoords({ x: 100, y: 100 }, 1, 10, 20)).toEqual({ x: 90, y: 80 });
  });
});
