/**
 * vue-i18n 实例（T4.1 / ADR-0013 / T2 多语言）
 *
 * 设计要点：
 * - locale 默认 zh-CN，fallback 为 en（新增语言如 ja 缺 key 时回退英文，
 *   而非中文；zh-CN/en 已由 locales.test.ts 保证 key 树完全一致，故 fallback
 *   不会产生异常回退）
 * - 运行时切换：调用方 `i18n.global.locale.value = lang`
 * - 历史会话使用 legacy: false（Composition API），$t 在模板中可用
 * - 不启用 SSR 同步等桌面应用不需要的特性
 * - 语言列表与 messages 均来自 locales/registry.ts（单一事实来源，T2）
 */
import { createI18n } from "vue-i18n";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  localeMessages,
} from "./locales/registry";
import type { AppLocale } from "./locales/registry";

export type { AppLocale } from "./locales/registry";
export { SUPPORTED_LOCALES, DEFAULT_LOCALE } from "./locales/registry";

/** 支持的语言列表（来自 LOCALE_DEFS，新增语言自动包含）——保留兼容导出 */
export const AVAILABLE_LOCALES = SUPPORTED_LOCALES;

/**
 * 回退语言：en。日语等新语言长尾 key 缺失时显示英文而非中文
 *（用户决策，多语言地图 #146）。en 与 zh-CN 的 key 树已由 locales.test.ts
 * 校验完全一致，故作为 fallback 安全。
 */
const FALLBACK_LOCALE = "en";

export const i18n = createI18n({
  legacy: false,
  locale: DEFAULT_LOCALE,
  fallbackLocale: FALLBACK_LOCALE,
  messages: localeMessages,
});

export function getLocale(): AppLocale {
  return i18n.global.locale.value as AppLocale;
}

/**
 * 切换运行时 locale。
 * 调用方负责：
 * 1. 调用此函数更新前端
 * 2. 调用 Tauri `reload_menu` 命令重建原生菜单
 * 3. 通过 persistence.updateSettings 持久化新语言
 */
export function setLocale(lang: AppLocale): void {
  i18n.global.locale.value = lang;
}