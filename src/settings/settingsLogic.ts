/**
 * 设置显式 Save 模型纯逻辑（Ticket #80 / T8.3）
 *
 * 把 draft 与 snapshot 的比较、按分类恢复默认等"可纯函数化"的逻辑从组件中抽出，
 * 便于单元测试（参考项目测试哲学：优先测纯逻辑，不测组件实现细节）。
 *
 * 分类与字段映射来自 spec 议题簇 8：
 * - 常规：uiMode / showHiddenFiles / showAgentPanel / defaultImageDir / checkUpdatesOnStartup
 * - 编辑器：editorMode / editorFontSize / editorLineHeight / editorFontFamily / showLineNumbers / softWrap
 * - AI：Provider 有独立持久化（useAiProvidersStore），不参与 footer Save 的 draft 模型
 */
import type { SettingsState } from "../types";
import { DEFAULT_SETTINGS } from "../types";

export type SettingsCategory = "general" | "editor" | "ai";

/** 常规分类下受 footer Save 管理的字段 */
export const GENERAL_FIELDS: (keyof SettingsState)[] = [
  "uiMode",
  "showHiddenFiles",
  "showAgentPanel",
  "defaultImageDir",
  "checkUpdatesOnStartup",
];

/** 编辑器分类下受 footer Save 管理的字段 */
export const EDITOR_FIELDS: (keyof SettingsState)[] = [
  "editorMode",
  "editorFontSize",
  "editorLineHeight",
  "editorFontFamily",
  "showLineNumbers",
  "softWrap",
];

/** 返回某分类下参与 draft 比较的字段列表（ai 不参与，provider 走独立持久化） */
export function fieldsForCategory(
  category: SettingsCategory
): (keyof SettingsState)[] {
  switch (category) {
    case "general":
      return GENERAL_FIELDS;
    case "editor":
      return EDITOR_FIELDS;
    default:
      return [];
  }
}

/** 判断指定分类是否有未保存改动 */
export function isCategoryDirty(
  draft: SettingsState,
  snapshot: SettingsState,
  category: SettingsCategory
): boolean {
  return fieldsForCategory(category).some((f) => draft[f] !== snapshot[f]);
}

/** 判断是否有任意未保存改动（general + editor，不含 ai） */
export function isDirty(
  draft: SettingsState,
  snapshot: SettingsState
): boolean {
  return (
    isCategoryDirty(draft, snapshot, "general") ||
    isCategoryDirty(draft, snapshot, "editor")
  );
}

/**
 * 将指定分类的字段重置为默认值，返回新 draft 对象（不 mutate 输入）。
 * 其他分类的字段保持不变。
 *
 * 显式按分类展开赋值（而非 for-in 索引写入）：避免 TS 对联合键索引写入
 * 收缩为 never 的限制，同时保持类型安全。
 */
export function restoreCategoryDefaults(
  draft: SettingsState,
  category: SettingsCategory
): SettingsState {
  switch (category) {
    case "general":
      return {
        ...draft,
        uiMode: DEFAULT_SETTINGS.uiMode,
        showHiddenFiles: DEFAULT_SETTINGS.showHiddenFiles,
        showAgentPanel: DEFAULT_SETTINGS.showAgentPanel,
        defaultImageDir: DEFAULT_SETTINGS.defaultImageDir,
        checkUpdatesOnStartup: DEFAULT_SETTINGS.checkUpdatesOnStartup,
      };
    case "editor":
      return {
        ...draft,
        editorMode: DEFAULT_SETTINGS.editorMode,
        editorFontSize: DEFAULT_SETTINGS.editorFontSize,
        editorLineHeight: DEFAULT_SETTINGS.editorLineHeight,
        editorFontFamily: DEFAULT_SETTINGS.editorFontFamily,
        showLineNumbers: DEFAULT_SETTINGS.showLineNumbers,
        softWrap: DEFAULT_SETTINGS.softWrap,
      };
    default:
      return { ...draft };
  }
}