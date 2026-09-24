/**
 * 应用版本号（运行时读取，单一来源）
 *
 * 读取 Tauri 打包版本（tauri.conf.json 的 version），避免各入口各自硬编码导致发版后过期。
 * 非 Tauri 环境（单测 / 浏览器预览）读取失败时降级为 fallback。
 */
import { getVersion } from "@tauri-apps/api/app";

/**
 * 获取应用版本号。
 * @param fallback 读取失败时的降级值，默认 "0.0.0"
 */
export async function getAppVersion(fallback = "0.0.0"): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return fallback;
  }
}