/**
 * 通过 WebDriver 协议执行 Tauri invoke 命令
 * tauri-driver 暴露了 `tauri:invoke` 扩展命令，可直接调用后端 #[tauri::command]
 */
import type { Browser } from "webdriverio";

/**
 * 调用 Tauri 后端命令
 * @param browser WebDriver Browser 实例
 * @param cmd 命令名（与 Rust 端 #[tauri::command] 函数名一致）
 * @param args 参数（驼峰键名，Tauri 自动转下划线）
 */
export async function invoke<T = unknown>(
  browser: Browser,
  cmd: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  // tauri-driver 通过扩展命令 `tauri:invoke` 调用后端
  // WebDriver 协议走 POST /session/:id/tauri/invoke
  const result = await browser.sendCommand(`tauri:invoke`, "POST", {
    cmd,
    args
  });
  return result as T;
}
