/** 平台守卫：e2e harness 与 spec 共用的平台判断 */
export const IS_WINDOWS = process.platform === "win32";
export const IS_LINUX = process.platform === "linux";
export const IS_MACOS = process.platform === "darwin";

/**
 * macOS 内嵌 WebDriver 服务端端口（tauri-plugin-wdio-webdriver 读 TAURI_WEBDRIVER_PORT，
 * 默认即 4445）。macOS 上没有 msedgedriver，与 Windows/Linux 的 4445 用途不冲突。
 *
 * 放在 platform.ts 而非 driver.ts：wait.ts 的 direct eval（#375 A）也要用它拼
 * `POST /wdio/eval` 的 URL —— 若从 driver.ts import 会形成
 * `wait → driver → store → wait` 循环依赖（driver → store → wait）。
 */
export const EMBEDDED_DRIVER_PORT = Number(process.env.TAURI_WEBDRIVER_PORT ?? 4445);

export function toAppPath(p: string): string {
  return IS_WINDOWS ? p : p.replace(/\\/g, "/");
}
