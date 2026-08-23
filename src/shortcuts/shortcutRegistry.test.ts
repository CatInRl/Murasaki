/**
 * shortcutRegistry 单元测试
 *
 * 校验注册表完整性（单一事实源约束）：
 * - 命令 ID 全局唯一
 * - 标签 key 非空
 * - 分类/作用域合法
 * - 默认绑定为规范格式（normalize 幂等）
 * - 默认绑定内部无冲突
 */
import { describe, it, expect } from "vitest";
import {
  SHORTCUT_COMMANDS,
  DEFAULT_SHORTCUTS,
  commandById,
  CATEGORY_ORDER,
  type ShortcutCategory,
  type ShortcutScope,
} from "./shortcutRegistry";
import { normalizeShortcut } from "./shortcutsLogic";

const VALID_CATEGORIES: ShortcutCategory[] = ["file", "edit", "paragraph", "view", "agent"];
const VALID_SCOPES: ShortcutScope[] = ["global", "editor"];

describe("shortcutRegistry - 完整性", () => {
  it("命令 ID 全局唯一", () => {
    const ids = SHORTCUT_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每条命令有非空 labelKey", () => {
    for (const c of SHORTCUT_COMMANDS) {
      expect(c.labelKey.length).toBeGreaterThan(0);
    }
  });

  it("分类与作用域均合法", () => {
    for (const c of SHORTCUT_COMMANDS) {
      expect(VALID_CATEGORIES).toContain(c.category);
      expect(VALID_SCOPES).toContain(c.scope);
    }
  });

  it("默认绑定为规范格式（normalize 幂等）", () => {
    for (const c of SHORTCUT_COMMANDS) {
      if (c.defaultShortcut === null) continue;
      expect(normalizeShortcut(c.defaultShortcut)).toBe(c.defaultShortcut);
    }
  });

  it("默认绑定内部无冲突", () => {
    const seen = new Map<string, string>();
    for (const c of SHORTCUT_COMMANDS) {
      if (c.defaultShortcut === null) continue;
      const prev = seen.get(c.defaultShortcut);
      expect(prev, `命令 ${prev} 与 ${c.id} 共享默认绑定 ${c.defaultShortcut}`).toBeUndefined();
      seen.set(c.defaultShortcut, c.id);
    }
  });

  it("commandById 能反查所有命令", () => {
    for (const c of SHORTCUT_COMMANDS) {
      expect(commandById(c.id)).toEqual(c);
    }
    expect(commandById("not-a-command")).toBeUndefined();
  });

  it("DEFAULT_SHORTCUTS 与注册表一致", () => {
    for (const c of SHORTCUT_COMMANDS) {
      expect(DEFAULT_SHORTCUTS[c.id]).toBe(c.defaultShortcut);
    }
  });

  it("CATEGORY_ORDER 包含全部已使用分类", () => {
    const used = new Set(SHORTCUT_COMMANDS.map((c) => c.category));
    for (const cat of used) {
      expect(CATEGORY_ORDER).toContain(cat);
    }
  });

  it("关键命令存在且绑定符合预期", () => {
    expect(commandById("new-file")?.defaultShortcut).toBe("Ctrl+N");
    expect(commandById("save")?.defaultShortcut).toBe("Ctrl+S");
    expect(commandById("close-tab")?.defaultShortcut).toBe("Ctrl+W");
    expect(commandById("heading-1")?.defaultShortcut).toBe("Ctrl+1");
    expect(commandById("task-list")?.defaultShortcut).toBe("Ctrl+Shift+X");
    expect(commandById("fullscreen")?.defaultShortcut).toBe("F11");
    expect(commandById("toggle-statusbar")?.defaultShortcut).toBe("Alt+Shift+S");
    // 统一全局搜索条：Ctrl+P 主入口 + Ctrl+Shift+F（find-in-files 重指向）
    expect(commandById("global-search")?.defaultShortcut).toBe("Ctrl+P");
    expect(commandById("global-search")?.scope).toBe("global");
    expect(commandById("find-in-files")?.defaultShortcut).toBe("Ctrl+Shift+F");
    // 段落命令作用域必须是 editor
    expect(commandById("code-block")?.scope).toBe("editor");
    // 文件命令作用域必须是 global
    expect(commandById("save")?.scope).toBe("global");
  });
});
