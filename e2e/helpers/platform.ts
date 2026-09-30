/** 平台守卫：e2e harness 与 spec 共用的平台判断 */
export const IS_WINDOWS = process.platform === "win32";
export const IS_LINUX = process.platform === "linux";
export const IS_MACOS = process.platform === "darwin";

export function toAppPath(p: string): string {
  return IS_WINDOWS ? p : p.replace(/\\/g, "/");
}
