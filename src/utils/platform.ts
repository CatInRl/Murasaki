/**
 * 平台检测工具
 *
 * 使用 navigator 平台信息判断当前操作系统，供快捷键格式化和菜单加速器
 * 等跨平台适配逻辑使用。纯函数、无副作用，便于单元测试。
 */
export type AppPlatform = "mac" | "windows" | "linux" | "unknown";

/** 检测当前操作系统平台 */
export function detectPlatform(): AppPlatform {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  if (ua.includes("Macintosh") || platform.toLowerCase().includes("mac")) {
    return "mac";
  }
  if (/Windows|Win/i.test(ua) || /Win/i.test(platform)) {
    return "windows";
  }
  if (/Linux|X11/i.test(ua)) {
    return "linux";
  }
  return "unknown";
}

/** 是否为 macOS */
export function isMac(): boolean {
  return detectPlatform() === "mac";
}