/**
 * settingsLogic 单元测试（Ticket #80 / T8.3 显式 Save 模型）
 *
 * 覆盖纯逻辑：分类字段映射 / dirty 比较 / 按分类恢复默认。
 * 不涉及 Tauri / Pinia / 组件，纯函数断言。
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, type SettingsState } from "../types";
import {
  GENERAL_FIELDS,
  EDITOR_FIELDS,
  fieldsForCategory,
  isCategoryDirty,
  isDirty,
  restoreCategoryDefaults,
} from "./settingsLogic";

function clone(s: SettingsState): SettingsState {
  return { ...s };
}

describe("settingsLogic - fieldsForCategory", () => {
  it("general 返回常规分类字段", () => {
    expect(fieldsForCategory("general")).toEqual(GENERAL_FIELDS);
    expect(GENERAL_FIELDS).toContain("uiMode");
    expect(GENERAL_FIELDS).toContain("showHiddenFiles");
    expect(GENERAL_FIELDS).toContain("showAgentPanel");
    expect(GENERAL_FIELDS).toContain("defaultImageDir");
  });

  it("editor 返回编辑器分类字段", () => {
    expect(fieldsForCategory("editor")).toEqual(EDITOR_FIELDS);
    expect(EDITOR_FIELDS).toContain("editorMode");
    expect(EDITOR_FIELDS).toContain("editorFontSize");
    expect(EDITOR_FIELDS).toContain("editorLineHeight");
    expect(EDITOR_FIELDS).toContain("editorFontFamily");
    expect(EDITOR_FIELDS).toContain("showLineNumbers");
    expect(EDITOR_FIELDS).toContain("softWrap");
  });

  it("ai 返回空数组（provider 走独立持久化）", () => {
    expect(fieldsForCategory("ai")).toEqual([]);
  });
});

describe("settingsLogic - isCategoryDirty", () => {
  it("draft 与 snapshot 完全一致时 general 不 dirty", () => {
    const draft = clone(DEFAULT_SETTINGS);
    const snapshot = clone(DEFAULT_SETTINGS);
    expect(isCategoryDirty(draft, snapshot, "general")).toBe(false);
  });

  it("修改 general 字段后 general 变 dirty", () => {
    const draft = clone(DEFAULT_SETTINGS);
    const snapshot = clone(DEFAULT_SETTINGS);
    draft.uiMode = "dark";
    expect(isCategoryDirty(draft, snapshot, "general")).toBe(true);
  });

  it("修改 general 字段不影响 editor 的 dirty 状态", () => {
    const draft = clone(DEFAULT_SETTINGS);
    const snapshot = clone(DEFAULT_SETTINGS);
    draft.uiMode = "dark";
    expect(isCategoryDirty(draft, snapshot, "editor")).toBe(false);
  });

  it("修改 editor 字段后 editor 变 dirty", () => {
    const draft = clone(DEFAULT_SETTINGS);
    const snapshot = clone(DEFAULT_SETTINGS);
    draft.editorFontSize = 20;
    expect(isCategoryDirty(draft, snapshot, "editor")).toBe(true);
  });

  it("修改 editor 字段不影响 general 的 dirty 状态", () => {
    const draft = clone(DEFAULT_SETTINGS);
    const snapshot = clone(DEFAULT_SETTINGS);
    draft.editorMode = "source";
    expect(isCategoryDirty(draft, snapshot, "general")).toBe(false);
  });

  it("ai 分类永远不 dirty（不参与 draft 模型）", () => {
    const draft = clone(DEFAULT_SETTINGS);
    const snapshot = clone(DEFAULT_SETTINGS);
    draft.uiMode = "dark";
    draft.editorFontSize = 20;
    expect(isCategoryDirty(draft, snapshot, "ai")).toBe(false);
  });
});

describe("settingsLogic - isDirty", () => {
  it("无任何改动时为 false", () => {
    const draft = clone(DEFAULT_SETTINGS);
    const snapshot = clone(DEFAULT_SETTINGS);
    expect(isDirty(draft, snapshot)).toBe(false);
  });

  it("仅 general 改动时为 true", () => {
    const draft = clone(DEFAULT_SETTINGS);
    const snapshot = clone(DEFAULT_SETTINGS);
    draft.showHiddenFiles = true;
    expect(isDirty(draft, snapshot)).toBe(true);
  });

  it("仅 editor 改动时为 true", () => {
    const draft = clone(DEFAULT_SETTINGS);
    const snapshot = clone(DEFAULT_SETTINGS);
    draft.softWrap = false;
    expect(isDirty(draft, snapshot)).toBe(true);
  });

  it("未暴露字段改动不影响 dirty（如 markdownTheme）", () => {
    const draft = clone(DEFAULT_SETTINGS);
    const snapshot = clone(DEFAULT_SETTINGS);
    draft.markdownTheme = "other-theme";
    expect(isDirty(draft, snapshot)).toBe(false);
  });
});

describe("settingsLogic - restoreCategoryDefaults", () => {
  it("恢复 general 分类：仅 general 字段回到默认，其他分类不变", () => {
    const draft: SettingsState = {
      ...DEFAULT_SETTINGS,
      uiMode: "dark",
      showHiddenFiles: true,
      defaultImageDir: "custom/dir",
      editorFontSize: 20,
      editorMode: "source",
      markdownTheme: "custom-theme",
    };
    const result = restoreCategoryDefaults(draft, "general");
    expect(result.uiMode).toBe(DEFAULT_SETTINGS.uiMode);
    expect(result.showHiddenFiles).toBe(DEFAULT_SETTINGS.showHiddenFiles);
    expect(result.defaultImageDir).toBe(DEFAULT_SETTINGS.defaultImageDir);
    expect(result.showAgentPanel).toBe(DEFAULT_SETTINGS.showAgentPanel);
    // editor 字段保持改动
    expect(result.editorFontSize).toBe(20);
    expect(result.editorMode).toBe("source");
    // 未暴露字段保持改动
    expect(result.markdownTheme).toBe("custom-theme");
  });

  it("恢复 editor 分类：仅 editor 字段回到默认，其他分类不变", () => {
    const draft: SettingsState = {
      ...DEFAULT_SETTINGS,
      uiMode: "dark",
      editorFontSize: 20,
      editorMode: "source",
      editorFontFamily: "Consolas",
      showLineNumbers: false,
    };
    const result = restoreCategoryDefaults(draft, "editor");
    expect(result.editorFontSize).toBe(DEFAULT_SETTINGS.editorFontSize);
    expect(result.editorMode).toBe(DEFAULT_SETTINGS.editorMode);
    expect(result.editorFontFamily).toBe(DEFAULT_SETTINGS.editorFontFamily);
    expect(result.showLineNumbers).toBe(DEFAULT_SETTINGS.showLineNumbers);
    expect(result.editorLineHeight).toBe(DEFAULT_SETTINGS.editorLineHeight);
    expect(result.softWrap).toBe(DEFAULT_SETTINGS.softWrap);
    // general 字段保持改动
    expect(result.uiMode).toBe("dark");
  });

  it("恢复 ai 分类：无字段变化（ai 不参与 draft 模型）", () => {
    const draft: SettingsState = {
      ...DEFAULT_SETTINGS,
      uiMode: "dark",
      editorFontSize: 20,
    };
    const result = restoreCategoryDefaults(draft, "ai");
    expect(result).toEqual(draft);
  });

  it("不 mutate 输入 draft", () => {
    const draft: SettingsState = {
      ...DEFAULT_SETTINGS,
      uiMode: "dark",
    };
    const draftCopy = clone(draft);
    restoreCategoryDefaults(draft, "general");
    expect(draft).toEqual(draftCopy);
  });
});