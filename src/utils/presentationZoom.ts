/**
 * 预览缩放纯逻辑（issue #181 / T3.2；生效范围扩到分屏见 #412）
 *
 * 不依赖 Vue / Tauri，便于单元测试。
 * 缩放为百分比整数，范围 [50, 200]，步进 10，默认 100。
 */

import type { EditorMode } from "../types";

export const PRESENTATION_ZOOM_MIN = 50;
export const PRESENTATION_ZOOM_MAX = 200;
export const PRESENTATION_ZOOM_STEP = 10;
export const PRESENTATION_ZOOM_DEFAULT = 100;

/**
 * 缩放生效于有预览区的模式（#412）。
 *
 * 缩放**入口**（`Ctrl+=` / `Ctrl+-` / `Ctrl+0` 快捷键是 `scope: "global"`，
 * HTML 预览 iframe 内的键鼠事件也经 #405 回接到父文档）不分模式，而**出口**
 * 曾经只认演示模式 —— 分屏下按快捷键只改状态不渲染，状态还被污染到
 * 切回演示模式时突然生效。凡有预览区的模式（分屏 + 演示）都应真实缩放；
 * 源码模式无预览区，不生效。
 */
export function zoomAppliesTo(editorMode: EditorMode): boolean {
  return editorMode === "split" || editorMode === "presentation";
}

/** 把任意数值夹取到合法缩放范围（非有限值回退默认值） */
export function clampPresentationZoom(value: number): number {
  if (!Number.isFinite(value)) return PRESENTATION_ZOOM_DEFAULT;
  const rounded = Math.round(value);
  return Math.min(PRESENTATION_ZOOM_MAX, Math.max(PRESENTATION_ZOOM_MIN, rounded));
}

/**
 * 按方向步进缩放并夹取到边界。
 * @param current 当前缩放百分比
 * @param direction 1=放大，-1=缩小
 */
export function stepPresentationZoom(current: number, direction: 1 | -1): number {
  return clampPresentationZoom(clampPresentationZoom(current) + direction * PRESENTATION_ZOOM_STEP);
}

/**
 * 预览缩放包裹层的行内样式（issue #337）。
 *
 * **只设 `zoom`，不要再反向除宽高等**：Chromium 下 `zoom` 会让该元素的百分比尺寸
 * 按「缩放后的包含块」解析 —— `width: 100%` 本身就会填满父容器。此前写法是
 * `zoom: z; width: calc(100% / z)`，等于**重复补偿**：包裹层实际只剩面板宽度的 1/z，
 * 放大后右侧留出越来越大的空白（实测 z=1.1/1.5/2 时内容右缘分别只到面板的 88% / 61% / 40%）。
 *
 * @param percent 缩放百分比（100 = 不缩放，此时不产出样式）
 * @returns 行内样式；无 zoom 需要时返回 undefined
 */
export function presentationZoomStyle(
  percent: number
): Record<string, string> | undefined {
  const z = percent / 100;
  if (!Number.isFinite(z) || z === 1) return undefined;
  return { zoom: String(z) };
}
