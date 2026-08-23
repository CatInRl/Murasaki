/**
 * 多语言注册表（单一事实来源，T2 / 多语言地图）
 *
 * 收敛所有「界面语言」相关定义到这一处：
 * - `LOCALE_DEFS` —— 受支持语言的元数据（code 显示名）
 * - `AppLocale`  —— 由 LOCALE_DEFS 的键派生
 * - `SUPPORTED_LOCALES` —— 语言列表
 * - `DEFAULT_LOCALE` —— 默认语言
 *
 * 新增语言只需在此处加一项 LOCALE_DEFS 条目并新增对应 locale 目录，
 * 语言下拉、i18n messages、类型都会自动跟随。
 * 注意：新增语言同时需在 src/locales/{lang} 下提供与 zh-CN 相同的模块结构
 *（common/menu/settings/editor/agent），并由 locales.test.ts 自动校验 key 同步。
 */
import type { LocaleMessages } from "vue-i18n";
import zhCN from "./zh-CN";
import en from "./en";
import ja from "./ja";

/** 每个受支持语言的显示名（用于设置面板语言下拉选项） */
export interface LocaleDef {
  /** 在设置下拉中展示的本地语言名（用该语言书写自身，如 中文/English/日本語） */
  displayName: string;
}

/**
 * 语言元数据表。键即语言代码（BCP 47），值声明该语言的本地显示名。
 * `satisfies` 约束确保：新增 locale 目录后若忘记在此登记，类型会报错。
 */
export const LOCALE_DEFS = {
  "zh-CN": { displayName: "简体中文" },
  en: { displayName: "English" },
  ja: { displayName: "日本語" },
} as const satisfies Record<string, LocaleDef>;

/** 界面语言类型：由 LOCALE_DEFS 的键派生（新增语言自动纳入） */
export type AppLocale = keyof typeof LOCALE_DEFS;

/** 受支持语言列表（新增语言自动包含） */
export const SUPPORTED_LOCALES = Object.keys(LOCALE_DEFS) as AppLocale[];

/** 默认语言（ADR-0013：zh-CN，保护现有用户） */
export const DEFAULT_LOCALE: AppLocale = "zh-CN";

/** 各语言的 vue-i18n message 资源（键结构需与 zh-CN 一致，由 locales.test.ts 校验） */
export const localeMessages = {
  "zh-CN": zhCN,
  en,
  ja,
} as const satisfies Record<AppLocale, LocaleMessages<unknown>>;