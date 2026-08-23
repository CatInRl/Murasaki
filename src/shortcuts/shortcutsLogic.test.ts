/**
 * shortcutsLogic 单元测试
 *
 * 覆盖纯逻辑：键名规范化 / 快捷键规范化解析 / 事件匹配与录制 /
 * CM 键名转换 / 有效绑定解析 / 冲突检测 / 绑定可用性校验。
 * 不涉及 Tauri / Vue / 组件，纯函数断言。
 */
import { describe, it, expect } from "vitest";
import {
  normalizeKeyName,
  normalizeShortcut,
  canonicalizeShortcut,
  parseShortcut,
  shortcutMatchesEvent,
  eventToShortcut,
  toCmKey,
  resolveShortcut,
  effectiveShortcuts,
  isDefaultShortcut,
  detectConflicts,
  isUsableShortcut,
  formatShortcut,
  setShortcutOverride,
  resetShortcutOverride,
} from "./shortcutsLogic";
import { DEFAULT_SHORTCUTS } from "./shortcutRegistry";

function keyEvent(partial: Partial<KeyboardEvent>): KeyboardEvent {
  return { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, key: "", ...partial } as KeyboardEvent;
}

describe("shortcutsLogic - normalizeKeyName", () => {
  it("单字母大写", () => {
    expect(normalizeKeyName("k")).toBe("K");
    expect(normalizeKeyName("K")).toBe("K");
    expect(normalizeKeyName("s")).toBe("S");
  });

  it("数字与标点保持原样", () => {
    expect(normalizeKeyName("1")).toBe("1");
    expect(normalizeKeyName("]")).toBe("]");
    expect(normalizeKeyName("[")).toBe("[");
  });

  it("特殊键名归一化", () => {
    expect(normalizeKeyName("tab")).toBe("Tab");
    expect(normalizeKeyName("Tab")).toBe("Tab");
    expect(normalizeKeyName("F11")).toBe("F11");
    expect(normalizeKeyName("f11")).toBe("F11");
    expect(normalizeKeyName("ArrowUp")).toBe("ArrowUp");
    expect(normalizeKeyName("arrowup")).toBe("ArrowUp");
    expect(normalizeKeyName("esc")).toBe("Escape");
    expect(normalizeKeyName("Enter")).toBe("Enter");
  });
});

describe("shortcutsLogic - normalizeShortcut", () => {
  it("规范输入幂等", () => {
    expect(normalizeShortcut("Ctrl+Shift+K")).toBe("Ctrl+Shift+K");
    expect(normalizeShortcut("Ctrl+N")).toBe("Ctrl+N");
    expect(normalizeShortcut("F11")).toBe("F11");
    expect(normalizeShortcut("Ctrl+Shift+]")).toBe("Ctrl+Shift+]");
  });

  it("小写/别名归一化", () => {
    expect(normalizeShortcut("ctrl+n")).toBe("Ctrl+N");
    expect(normalizeShortcut("Ctrl-Shift-k")).toBe("Ctrl+Shift+K");
    expect(normalizeShortcut("cmd+s")).toBe("Ctrl+S");
    expect(normalizeShortcut("control+shift+f")).toBe("Ctrl+Shift+F");
    expect(normalizeShortcut("alt+shift+s")).toBe("Alt+Shift+S");
    expect(normalizeShortcut("Ctrl + Tab")).toBe("Ctrl+Tab");
  });

  it("修饰键顺序按输入保留、重复去重", () => {
    expect(normalizeShortcut("Alt+Ctrl+K")).toBe("Alt+Ctrl+K");
    expect(normalizeShortcut("Shift+Alt+Ctrl+K")).toBe("Shift+Alt+Ctrl+K");
    expect(normalizeShortcut("Ctrl+Ctrl+K")).toBe("Ctrl+K");
  });

  it("无效输入返回 null", () => {
    expect(normalizeShortcut("")).toBeNull();
    expect(normalizeShortcut(null)).toBeNull();
    expect(normalizeShortcut(undefined)).toBeNull();
    expect(normalizeShortcut("Ctrl")).toBeNull();
    expect(normalizeShortcut("Ctrl+Shift")).toBeNull();
    expect(normalizeShortcut("Ctrl+A+B")).toBeNull();
    expect(normalizeShortcut("  +  ")).toBeNull();
  });
});

describe("shortcutsLogic - parseShortcut", () => {
  it("解析修饰键与主键", () => {
    expect(parseShortcut("Ctrl+Shift+K")).toEqual({ ctrl: true, shift: true, alt: false, key: "K" });
    expect(parseShortcut("Alt+Shift+S")).toEqual({ ctrl: false, shift: true, alt: true, key: "S" });
    expect(parseShortcut("F11")).toEqual({ ctrl: false, shift: false, alt: false, key: "F11" });
    expect(parseShortcut("Ctrl+1")).toEqual({ ctrl: true, shift: false, alt: false, key: "1" });
  });

  it("无效返回 null", () => {
    expect(parseShortcut(null)).toBeNull();
    expect(parseShortcut("Shift")).toBeNull();
  });
});

describe("shortcutsLogic - canonicalizeShortcut", () => {
  it("修饰键重排为固定顺序 Ctrl > Shift > Alt", () => {
    expect(canonicalizeShortcut("Ctrl+Shift+K")).toBe("Ctrl+Shift+K");
    expect(canonicalizeShortcut("Alt+Shift+S")).toBe("Shift+Alt+S");
  });

  it("顺序不同的等价组合 canonical 相同", () => {
    expect(canonicalizeShortcut("Shift+Ctrl+K")).toBe(canonicalizeShortcut("Ctrl+Shift+K"));
    expect(canonicalizeShortcut("Alt+Ctrl+K")).toBe(canonicalizeShortcut("Ctrl+Alt+K"));
  });

  it("无效返回 null", () => {
    expect(canonicalizeShortcut(null)).toBeNull();
    expect(canonicalizeShortcut("Ctrl")).toBeNull();
  });
});

describe("shortcutsLogic - shortcutMatchesEvent", () => {
  it("Ctrl+S 匹配 ctrl+s", () => {
    expect(shortcutMatchesEvent("Ctrl+S", keyEvent({ ctrlKey: true, key: "s" }))).toBe(true);
  });

  it("Ctrl 视为主修饰键：metaKey 也能匹配", () => {
    expect(shortcutMatchesEvent("Ctrl+S", keyEvent({ metaKey: true, key: "s" }))).toBe(true);
  });

  it("缺修饰键不匹配", () => {
    expect(shortcutMatchesEvent("Ctrl+S", keyEvent({ key: "s" }))).toBe(false);
  });

  it("额外修饰键不匹配", () => {
    expect(shortcutMatchesEvent("Ctrl+S", keyEvent({ ctrlKey: true, shiftKey: true, key: "s" }))).toBe(false);
  });

  it("F11 单独匹配", () => {
    expect(shortcutMatchesEvent("F11", keyEvent({ key: "F11" }))).toBe(true);
    expect(shortcutMatchesEvent("F11", keyEvent({ ctrlKey: true, key: "F11" }))).toBe(false);
  });

  it("Alt+Shift+S 匹配", () => {
    expect(shortcutMatchesEvent("Alt+Shift+S", keyEvent({ altKey: true, shiftKey: true, key: "S" }))).toBe(true);
  });

  it("无效快捷键恒 false", () => {
    expect(shortcutMatchesEvent(null, keyEvent({ ctrlKey: true, key: "s" }))).toBe(false);
    expect(shortcutMatchesEvent("Ctrl", keyEvent({ ctrlKey: true, key: "s" }))).toBe(false);
  });
});

describe("shortcutsLogic - eventToShortcut", () => {
  it("录制 Ctrl+Shift+K", () => {
    expect(eventToShortcut(keyEvent({ ctrlKey: true, shiftKey: true, key: "k" }))).toBe("Ctrl+Shift+K");
  });

  it("metaKey 折叠为主修饰键 Ctrl", () => {
    expect(eventToShortcut(keyEvent({ metaKey: true, key: "s" }))).toBe("Ctrl+S");
  });

  it("F11 录制", () => {
    expect(eventToShortcut(keyEvent({ key: "F11" }))).toBe("F11");
  });

  it("录制结果可被 normalize 还原", () => {
    // eventToShortcut 按 Ctrl > Shift > Alt 顺序输出
    expect(normalizeShortcut(eventToShortcut(keyEvent({ altKey: true, shiftKey: true, key: "s" })))).toBe("Shift+Alt+S");
  });

  it("纯修饰键返回 null", () => {
    expect(eventToShortcut(keyEvent({ ctrlKey: true, key: "Control" }))).toBeNull();
    expect(eventToShortcut(keyEvent({ key: "Shift" }))).toBeNull();
    expect(eventToShortcut(keyEvent({ key: "CapsLock" }))).toBeNull();
  });
});

describe("shortcutsLogic - toCmKey", () => {
  it("Ctrl 转 Mod", () => {
    expect(toCmKey("Ctrl+S")).toBe("Mod-s");
    expect(toCmKey("Ctrl+Shift+K")).toBe("Mod-Shift-k");
    expect(toCmKey("Ctrl+1")).toBe("Mod-1");
  });

  it("Alt 与无修饰键", () => {
    expect(toCmKey("Alt+Shift+S")).toBe("Shift-Alt-s");
    expect(toCmKey("F11")).toBe("F11");
    expect(toCmKey("Ctrl+Tab")).toBe("Mod-Tab");
  });

  it("方括号键", () => {
    expect(toCmKey("Ctrl+Shift+]")).toBe("Mod-Shift-]");
    expect(toCmKey("Ctrl+Shift+[")).toBe("Mod-Shift-[");
  });

  it("无效返回 null", () => {
    expect(toCmKey(null)).toBeNull();
    expect(toCmKey("Ctrl")).toBeNull();
  });
});

describe("shortcutsLogic - resolveShortcut / effectiveShortcuts", () => {
  it("未覆盖时返回默认绑定", () => {
    expect(resolveShortcut({}, "save")).toBe(DEFAULT_SHORTCUTS.save);
    expect(resolveShortcut({}, "settings")).toBeNull();
  });

  it("覆盖优先，且做规范化", () => {
    expect(resolveShortcut({ save: "ctrl+shift+s" }, "save")).toBe("Ctrl+Shift+S");
  });

  it("null 覆盖表示禁用", () => {
    expect(resolveShortcut({ save: null }, "save")).toBeNull();
  });

  it("effectiveShortcuts 返回全部命令有效绑定", () => {
    const eff = effectiveShortcuts({ save: "Ctrl+Alt+S" });
    expect(eff.save).toBe("Ctrl+Alt+S");
    expect(eff["new-file"]).toBe(DEFAULT_SHORTCUTS["new-file"]);
    expect(eff.settings).toBeNull();
    expect(Object.keys(eff).length).toBeGreaterThan(20);
  });
});

describe("shortcutsLogic - isDefaultShortcut", () => {
  it("默认即 true", () => {
    expect(isDefaultShortcut({}, "save")).toBe(true);
    expect(isDefaultShortcut({}, "settings")).toBe(true);
  });

  it("改绑后 false", () => {
    expect(isDefaultShortcut({ save: "Ctrl+Shift+S" }, "save")).toBe(false);
  });

  it("禁用（null）后 false", () => {
    expect(isDefaultShortcut({ save: null }, "save")).toBe(false);
  });
});

describe("shortcutsLogic - setShortcutOverride / resetShortcutOverride", () => {
  it("写入自定义绑定并规范化", () => {
    const next = setShortcutOverride({}, "save", "ctrl+shift+s");
    expect(next).toEqual({ save: "Ctrl+Shift+S" });
  });

  it("写入与默认相同的绑定 → 删除覆盖（保持覆盖表最小）", () => {
    const next = setShortcutOverride({ save: "Ctrl+Shift+S" }, "save", "Ctrl+S");
    expect(next).toEqual({});
  });

  it("写入 null 表示禁用", () => {
    const next = setShortcutOverride({}, "save", null);
    expect(next).toEqual({ save: null });
  });

  it("默认绑定为 null 的命令写入 null → 删除覆盖", () => {
    const next = setShortcutOverride({ settings: "Ctrl+," }, "settings", null);
    expect(next).toEqual({});
  });

  it("不 mutate 输入", () => {
    const overrides = { save: "Ctrl+Alt+S" };
    const copy = { ...overrides };
    setShortcutOverride(overrides, "save", "Ctrl+S");
    expect(overrides).toEqual(copy);
  });

  it("resetShortcutOverride 删除指定覆盖，其他保留", () => {
    const next = resetShortcutOverride({ save: "Ctrl+Shift+S", quit: null }, "save");
    expect(next).toEqual({ quit: null });
  });

  it("resetShortcutOverride 对不存在覆盖的命令无副作用", () => {
    expect(resetShortcutOverride({}, "save")).toEqual({});
  });
});

describe("shortcutsLogic - detectConflicts", () => {
  it("默认无冲突", () => {
    expect(detectConflicts({})).toEqual([]);
  });

  it("两个命令改绑同一键时检测到冲突", () => {
    const conflicts = detectConflicts({ save: "Ctrl+O", "open-file": "Ctrl+O" });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].shortcut).toBe("Ctrl+O");
    const ids = conflicts[0].commands.map((c) => c.id).sort();
    expect(ids).toEqual(["open-file", "save"]);
  });

  it("禁用一个命令后冲突解除", () => {
    expect(detectConflicts({ save: "Ctrl+O", "open-file": null })).toEqual([]);
  });

  it("大小写不同的同一绑定视为冲突", () => {
    const conflicts = detectConflicts({ save: "ctrl+o", "open-file": "Ctrl+O" });
    expect(conflicts).toHaveLength(1);
  });

  it("修饰键顺序不同但按键相同视为冲突", () => {
    // Ctrl+Alt+O 不与任何默认绑定冲突，只涉及 save 与 open-file
    const conflicts = detectConflicts({ save: "Alt+Ctrl+O", "open-file": "Ctrl+Alt+O" });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].commands.map((c) => c.id).sort()).toEqual(["open-file", "save"]);
  });
});

describe("shortcutsLogic - isUsableShortcut", () => {
  it("带 Ctrl 的字符键可用", () => {
    expect(isUsableShortcut("Ctrl+K")).toBe(true);
    expect(isUsableShortcut("Ctrl+1")).toBe(true);
    expect(isUsableShortcut("Ctrl+Shift+]")).toBe(true);
  });

  it("功能/导航键可无修饰绑定", () => {
    expect(isUsableShortcut("F11")).toBe(true);
    expect(isUsableShortcut("F5")).toBe(true);
    expect(isUsableShortcut("Escape")).toBe(true);
    expect(isUsableShortcut("Tab")).toBe(true);
  });

  it("裸字符键不可用（会吞掉打字）", () => {
    expect(isUsableShortcut("A")).toBe(false);
    expect(isUsableShortcut("1")).toBe(false);
    expect(isUsableShortcut("Shift+A")).toBe(false);
    expect(isUsableShortcut("Space")).toBe(false);
  });

  it("Alt 修饰的字符键可用", () => {
    expect(isUsableShortcut("Alt+K")).toBe(true);
  });

  it("无效返回 false", () => {
    expect(isUsableShortcut(null)).toBe(false);
    expect(isUsableShortcut("Ctrl")).toBe(false);
  });
});

describe("shortcutsLogic - formatShortcut", () => {
  it("规范格式化", () => {
    expect(formatShortcut("ctrl+shift+s")).toBe("Ctrl+Shift+S");
  });

  it("无绑定返回 null", () => {
    expect(formatShortcut(null)).toBeNull();
  });
});
