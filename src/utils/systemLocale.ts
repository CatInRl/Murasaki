/**
 * 系统语言映射（issue #141 首启多语言）
 *
 * 把原始系统 locale 字符串（如 sys-locale 返回的 "zh-CN"/"ja"/"fr-FR"）归一为
 * 受支持语言（AppLocale）。映射规则（大小写无关）：
 * - 含 `zh` → "zh-CN"
 * - 含 `ja` → "ja"
 * - 其他（含 en、其他语言、null/undefined）→ "en"
 *
 * 说明：前端可能直接收到系统探测命令返回受支持语言，也可能拿到其它来源的
 * 原始 locale（如 tauri 其它 API），统一经此函数兜底归一。
 */
import type { AppLocale } from "../locales/registry";

export function mapSystemLocale(raw: string | null | undefined): AppLocale {
  const lower = (raw ?? "").toLowerCase();
  if (lower.includes("zh")) return "zh-CN";
  if (lower.includes("ja")) return "ja";
  return "en";
}