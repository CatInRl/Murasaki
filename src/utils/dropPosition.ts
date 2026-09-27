/**
 * 拖放落点换算（issue #288）
 *
 * Tauri 原生 drag-drop 事件 `tauri://drag-drop` 的 payload 带 `position`：它是**相对窗口
 * 左上角（含标题栏与边框）的物理像素**。而 CodeMirror 的 `view.posAtCoords()` 需要
 * **视口 CSS 像素**的 `clientX/clientY`（相对 webview 内容区左上角），因此要先把物理像素
 * 按 `devicePixelRatio` 折成 CSS 像素，再减掉窗口装饰造成的偏移。
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
 * 窗口装饰（标题栏 + 边框）在 **CSS 像素**下的经验偏移。
 *
 * Tauri 的 `position` 相对**整个窗口**左上角（Windows 上由窗口的 `IDropTarget` 给出，
 * 含非客户区），而 `clientX/clientY` 相对 webview 内容区左上角，故要减去这部分。
 *
 * ⚠️ **这是经验值，必须在真机上按实际窗口装饰校准**：本仓库的 CI 与开发沙箱都无法真的
 * 从桌面拖文件进窗口（e2e 只能派发同名事件，`position` 是构造值），因此这两个常量**未经
 * 实测校准**，仅取一个常见量级（Windows 默认标题栏约 31px、边框约 8px）。
 */
export const WINDOW_DECORATION_OFFSET_X = 8;
export const WINDOW_DECORATION_OFFSET_Y = 31;

/**
 * 把 Tauri 给的窗口物理像素落点换算成视口 CSS 像素（即 `clientX/clientY`）。
 *
 * @param position 物理像素落点；缺省/非法（NaN、负值）时返回 null
 * @param devicePixelRatio 当前设备的 DPR；非法（NaN、<= 0）时按 1 处理
 * @param offsetX 窗口装饰水平偏移（CSS 像素），默认 {@link WINDOW_DECORATION_OFFSET_X}
 * @param offsetY 窗口装饰垂直偏移（CSS 像素），默认 {@link WINDOW_DECORATION_OFFSET_Y}
 * @returns 视口 CSS 坐标；换算不出（结果非有限或为负）时返回 null
 */
export function toViewportCoords(
  position: PhysicalPoint | null | undefined,
  devicePixelRatio: number,
  offsetX: number = WINDOW_DECORATION_OFFSET_X,
  offsetY: number = WINDOW_DECORATION_OFFSET_Y
): PhysicalPoint | null {
  if (!position) return null;
  const { x, y } = position;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // 只拒绝负值：`0` 是合法落点（贴近窗口/内容区左上角），旧实现按 `<= 0` 一律作废，
  // 导致贴近左上角拖入被误判为无效、回退到「插入当前光标」（issue #288 审查）
  if (x < 0 || y < 0) return null;

  const dpr =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;

  const viewX = x / dpr - offsetX;
  const viewY = y / dpr - offsetY;
  if (!Number.isFinite(viewX) || !Number.isFinite(viewY)) return null;
  if (viewX < 0 || viewY < 0) return null;

  return { x: viewX, y: viewY };
}
