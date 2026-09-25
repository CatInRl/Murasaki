/**
 * 窗口上下文（多窗口支持，spec #194）
 *
 * 每个 Tauri 窗口是独立 WebView，前端 Pinia 状态天然按窗口隔离；
 * 但**持久化**是全局单文件（`%APPDATA%\murasaki\`），因此需要按窗口区分 key：
 * - 主窗口（label `"main"`）沿用旧的 `"state"` key → 历史 `tabs.json` 天然迁移，
 *   无需一次性迁移代码；也只有主窗口参与「启动时恢复上次会话」。
 * - 其它窗口（`win-1` / `win-2` …）按 label 分槽，避免互相覆盖会话。
 */
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

/** 主窗口 label（Rust 侧 `setup` 中手动创建） */
export const MAIN_WINDOW_LABEL = "main";

/**
 * 本窗口的 label。
 * 非 Tauri 环境（单元测试 / 纯浏览器）回退为主窗口，保证函数总是可用。
 */
export function currentWindowLabel(): string {
  try {
    return getCurrentWebviewWindow().label || MAIN_WINDOW_LABEL;
  } catch {
    return MAIN_WINDOW_LABEL;
  }
}

/**
 * 是否主窗口。
 * 只有主窗口写回 `settings.lastWorkspacePath` 与参与启动会话恢复，
 * 否则多窗口会互相覆盖（spec #194 决策 ④ / T2.1）。
 */
export function isMainWindow(label: string = currentWindowLabel()): boolean {
  return label === MAIN_WINDOW_LABEL;
}

/**
 * `tabs.json` 中本窗口的存储 key。
 * 主窗口沿用 `"state"`，其它窗口为 `"state:<label>"`。
 */
export function tabsStoreKey(label: string = currentWindowLabel()): string {
  return isMainWindow(label) ? "state" : `state:${label}`;
}
