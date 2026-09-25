/**
 * 演示模式缩放纯逻辑（issue #181 / T3.2）
 *
 * 不依赖 Vue / Tauri，便于单元测试。
 * 缩放为百分比整数，范围 [50, 200]，步进 10，默认 100。
 */

export const PRESENTATION_ZOOM_MIN = 50;
export const PRESENTATION_ZOOM_MAX = 200;
export const PRESENTATION_ZOOM_STEP = 10;
export const PRESENTATION_ZOOM_DEFAULT = 100;

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
