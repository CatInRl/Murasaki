/**
 * vue-i18n 实例（T4.1 / ADR-0013）
 *
 * 设计要点：
 * - locale 默认 zh-CN，fallback 也为 zh-CN（避免英文字典缺失时显示 key）
 * - 运行时切换：调用方 `i18n.global.locale.value = lang`
 * - 历史会话使用 legacy: false（Composition API），$t 在模板中可用
 * - 不启用 SSR 同步等桌面应用不需要的特性
 */
import { createI18n } from "vue-i18n";
import type { AppLocale } from "./types";
import zhCN from "./locales/zh-CN";
import en from "./locales/en";

export type { AppLocale };

export const SUPPORTED_LOCALES: AppLocale[] = ["zh-CN", "en"];

export const i18n = createI18n({
  legacy: false,
  locale: "zh-CN",
  fallbackLocale: "zh-CN",
  messages: {
    "zh-CN": zhCN,
    en,
  },
});

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
