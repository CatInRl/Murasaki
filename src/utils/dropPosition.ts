/**
 * 拖放落点换算（issue #288；坐标口径修正见 #344）
 *
 * Tauri 原生 drag-drop 事件的 payload 带 `position`：它是**物理像素**，且已经是
 * **相对指针目标客户区左上角**的坐标 —— wry 在把 OLE 的落点交给上层之前调了
 * `ScreenToClient(hwnd, pt)`（见 wry `src/webview2/drag_drop.rs` 的 `DragEnter` /
 * `DragOver` / `Drop`），而该 HWND 的客户区就是 webview 的内容区。也就是说它与
 * `clientX/clientY` 同源，只差一次 DPI 折算。
 *
 * 因此这里**只做「物理像素 → CSS 像素」**（÷ DPR），不再减任何「窗口装饰偏移」：
 * 此前额外减了一个经验值（标题栏 + 边框）属于重复扣减，会把插入点上移约一个标题栏的
 * 高度、左移约一个边框宽（issue #344：拖入图片的插入位置不准确）。
 *
 * 纯函数，便于单测；换算不出（坐标为负/NaN 等）时返回 `null`，调用方据此回退到「插入到
 * 当前光标位置」，而不是抛错。
 */

/** 物理像素落点（Tauri payload 的 `position` 形态） */
export interface PhysicalPoint {
  x: number;
  y: number;
}

/**
 * 把 Tauri 给的窗口物理像素落点换算成视口 CSS 像素（即 `clientX/clientY`）。
 *
 * @param position 物理像素落点；缺省/非法（NaN、负值）时返回 null
 * @param devicePixelRatio 当前设备的 DPR；非法（NaN、<= 0）时按 1 处理
 * @returns 视口 CSS 坐标；换算不出（结果非有限或为负）时返回 null
 */
export function toViewportCoords(
  position: PhysicalPoint | null | undefined,
  devicePixelRatio: number
): PhysicalPoint | null {
  if (!position) return null;
  const { x, y } = position;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // 只拒绝负值：`0` 是合法落点（贴近内容区左上角），旧实现按 `<= 0` 一律作废，
  // 导致贴近左上角拖入被误判为无效、回退到「插入当前光标」（issue #288 审查）
  if (x < 0 || y < 0) return null;

  const dpr =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;

  const viewX = x / dpr;
  const viewY = y / dpr;
  if (!Number.isFinite(viewX) || !Number.isFinite(viewY)) return null;

  return { x: viewX, y: viewY };
}
