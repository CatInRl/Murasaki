/**
 * presentationZoom 单元测试（T3.2 演示模式缩放；#412 生效范围扩到分屏）
 *
 * 覆盖步进与边界夹取：范围 50–200、步进 10、非法输入回落到默认 100；
 * zoomAppliesTo 按模式判定生效范围。
 */
import { describe, it, expect } from "vitest";
import {
  PRESENTATION_ZOOM_DEFAULT,
  PRESENTATION_ZOOM_MAX,
  PRESENTATION_ZOOM_MIN,
  PRESENTATION_ZOOM_STEP,
  clampPresentationZoom,
  presentationZoomStyle,
  stepPresentationZoom,
  zoomAppliesTo,
} from "./presentationZoom";
import type { EditorMode } from "../types";

describe("presentationZoom - zoomAppliesTo（#412）", () => {
  it("有预览区的模式生效：分屏 + 演示", () => {
    expect(zoomAppliesTo("split")).toBe(true);
    expect(zoomAppliesTo("presentation")).toBe(true);
  });

  it("无预览区的模式不生效：源码 + 所见即所得", () => {
    expect(zoomAppliesTo("source")).toBe(false);
    expect(zoomAppliesTo("wysiwyg")).toBe(false);
  });

  it("四种 EditorMode 全覆盖", () => {
    const modes: EditorMode[] = ["source", "split", "wysiwyg", "presentation"];
    for (const mode of modes) {
      expect(typeof zoomAppliesTo(mode)).toBe("boolean");
    }
  });
});

describe("presentationZoom - 常量", () => {
  it("范围 50–200、步进 10、默认 100", () => {
    expect(PRESENTATION_ZOOM_MIN).toBe(50);
    expect(PRESENTATION_ZOOM_MAX).toBe(200);
    expect(PRESENTATION_ZOOM_STEP).toBe(10);
    expect(PRESENTATION_ZOOM_DEFAULT).toBe(100);
  });
});

describe("presentationZoom - clampPresentationZoom", () => {
  it("范围内取整原样返回", () => {
    expect(clampPresentationZoom(100)).toBe(100);
    expect(clampPresentationZoom(150)).toBe(150);
    expect(clampPresentationZoom(150.4)).toBe(150);
  });

  it("越界夹取到上下限", () => {
    expect(clampPresentationZoom(0)).toBe(50);
    expect(clampPresentationZoom(-40)).toBe(50);
    expect(clampPresentationZoom(999)).toBe(200);
  });

  it("非法数值回落到默认 100", () => {
    expect(clampPresentationZoom(Number.NaN)).toBe(100);
    expect(clampPresentationZoom(Number.POSITIVE_INFINITY)).toBe(100);
  });
});

describe("presentationZoom - stepPresentationZoom", () => {
  it("每次放大/缩小一个步进（10%）", () => {
    expect(stepPresentationZoom(100, 1)).toBe(110);
    expect(stepPresentationZoom(100, -1)).toBe(90);
  });

  it("到达边界后不再越界", () => {
    expect(stepPresentationZoom(200, 1)).toBe(200);
    expect(stepPresentationZoom(50, -1)).toBe(50);
    expect(stepPresentationZoom(195, 1)).toBe(200);
    expect(stepPresentationZoom(55, -1)).toBe(50);
  });

  it("连续步进累计到边界", () => {
    let zoom = 100;
    for (let i = 0; i < 20; i++) zoom = stepPresentationZoom(zoom, 1);
    expect(zoom).toBe(200);
    for (let i = 0; i < 20; i++) zoom = stepPresentationZoom(zoom, -1);
    expect(zoom).toBe(50);
  });

  it("入参非法时先回落默认再步进", () => {
    expect(stepPresentationZoom(Number.NaN, 1)).toBe(110);
  });
});

describe("presentationZoom - presentationZoomStyle", () => {
  it("100% 时不产出样式（无需缩放）", () => {
    expect(presentationZoomStyle(100)).toBeUndefined();
  });

  it("只产出 zoom，不再反向除宽高（#337）", () => {
    expect(presentationZoomStyle(200)).toEqual({ zoom: "2" });
    expect(presentationZoomStyle(110)).toEqual({ zoom: "1.1" });
    expect(presentationZoomStyle(50)).toEqual({ zoom: "0.5" });
  });

  it("绝不产出自带反向补偿的 width / height", () => {
    for (const percent of [50, 70, 110, 150, 200]) {
      const style = presentationZoomStyle(percent) ?? {};
      expect(Object.keys(style)).toEqual(["zoom"]);
    }
  });
});
