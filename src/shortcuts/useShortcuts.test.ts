/**
 * 快捷键运行时接线测试
 *
 * - buildEditorShortcutExtension：编辑器 keymap 生成（默认/自定义/禁用三种覆盖场景）
 * - useShortcuts().matchGlobalKeydown：全局 keydown 匹配（默认/未命中/自定义/禁用）
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { ShortcutOverrides } from "./shortcutsLogic";
import { buildEditorShortcutExtension, useShortcuts } from "./useShortcuts";
import { usePersistenceStore } from "../stores/usePersistenceStore";

// ===== buildEditorShortcutExtension =====

function makeView(overrides: ShortcutOverrides): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return new EditorView({
    state: EditorState.create({
      doc: "hello",
      extensions: [
        markdown({ base: markdownLanguage }),
        keymap.of(defaultKeymap),
        buildEditorShortcutExtension(overrides),
      ],
    }),
    parent: host,
  });
}

function getDoc(v: EditorView): string {
  return v.state.doc.toString();
}

// ===== 真实浏览器键事件模拟 =====
// jsdom 的 KeyboardEvent 不带 keyCode（真实浏览器总是有），而 CM 依赖 keyCode 做
// base key 回退匹配（见 @codemirror/view runHandlers）；同时真实浏览器中按 Shift
// 会把 event.key 变成上档字符（US 布局）。不模拟这两点，带 Shift/Alt 的绑定在
// 测试里会匹配不到（或误命中 defaultKeymap 的同键绑定）。

/** US 布局上档字符映射（仅字母无此项，直接大写即可） */
const SHIFTED_KEYS: Record<string, string> = {
  "`": "~", "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^",
  "7": "&", "8": "*", "9": "(", "0": ")", "-": "_", "=": "+",
  "[": "{", "]": "}", "\\": "|", ";": ":", "'": "\"", ",": "<", ".": ">", "/": "?",
};

/** 按键 keyCode（字母/数字/F 键动态计算） */
const PUNCT_CODES: Record<string, number> = {
  "`": 192, "-": 189, "=": 187, "[": 219, "]": 221, "\\": 220,
  ";": 186, "'": 222, ",": 188, ".": 190, "/": 191,
};

function keyCodeFor(key: string): number {
  if (/^[a-z]$/i.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(key)) return 48 + Number(key);
  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(key)) return 111 + Number(key.slice(1));
  return PUNCT_CODES[key] ?? 0;
}

function press(
  v: EditorView,
  key: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}
): void {
  const shift = mods.shift ?? false;
  const effectiveKey = shift
    ? (SHIFTED_KEYS[key] ?? (/^[a-z]$/.test(key) ? key.toUpperCase() : key))
    : key;
  const event = new KeyboardEvent("keydown", {
    key: effectiveKey,
    bubbles: true,
    cancelable: true,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: shift,
    altKey: mods.alt ?? false,
  });
  Object.defineProperty(event, "keyCode", { value: keyCodeFor(key), configurable: true });
  v.contentDOM.dispatchEvent(event);
}

describe("buildEditorShortcutExtension - 默认绑定", () => {
  it("Ctrl+1 → 一级标题", () => {
    const v = makeView({});
    press(v, "1", { ctrl: true });
    expect(getDoc(v)).toBe("# hello");
  });

  it("Ctrl+Shift+K → 代码块", () => {
    const v = makeView({});
    v.dispatch({ selection: { anchor: 0, head: 5 } });
    press(v, "K", { ctrl: true, shift: true });
    expect(getDoc(v)).toBe("```\nhello\n```");
  });

  it("Ctrl+Shift+] → 无序列表", () => {
    const v = makeView({});
    press(v, "]", { ctrl: true, shift: true });
    expect(getDoc(v)).toBe("- hello");
  });
});

describe("buildEditorShortcutExtension - 自定义覆盖", () => {
  it("覆盖 heading-1 为 Ctrl+Alt+H：新键生效，旧键失效", () => {
    const v = makeView({ "heading-1": "Ctrl+Alt+H" });
    press(v, "H", { ctrl: true, alt: true });
    expect(getDoc(v)).toBe("# hello");
    // 旧默认键 Ctrl+1 不再绑定
    const v2 = makeView({ "heading-1": "Ctrl+Alt+H" });
    press(v2, "1", { ctrl: true });
    expect(getDoc(v2)).toBe("hello");
  });
});

describe("buildEditorShortcutExtension - 禁用（null）", () => {
  it("heading-1 禁用后 Ctrl+1 无动作", () => {
    const v = makeView({ "heading-1": null });
    press(v, "1", { ctrl: true });
    expect(getDoc(v)).toBe("hello");
  });
});

// ===== useShortcuts().matchGlobalKeydown =====

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("useShortcuts - matchGlobalKeydown", () => {
  it("默认绑定：Ctrl+S 匹配 save", () => {
    const { matchGlobalKeydown } = useShortcuts();
    expect(
      matchGlobalKeydown(new KeyboardEvent("keydown", { key: "s", ctrlKey: true }))
    ).toBe("save");
  });

  it("未命中返回 null（无修饰键/未知组合）", () => {
    const { matchGlobalKeydown } = useShortcuts();
    expect(matchGlobalKeydown(new KeyboardEvent("keydown", { key: "x" }))).toBeNull();
    expect(
      matchGlobalKeydown(new KeyboardEvent("keydown", { key: "x", ctrlKey: true }))
    ).toBeNull();
  });

  it("自定义覆盖生效：Alt+S 触发 save，Ctrl+S 失效", () => {
    const persistence = usePersistenceStore();
    persistence.settings.shortcuts = { save: "Alt+S" };
    const { matchGlobalKeydown } = useShortcuts();
    expect(
      matchGlobalKeydown(new KeyboardEvent("keydown", { key: "s", altKey: true }))
    ).toBe("save");
    expect(
      matchGlobalKeydown(new KeyboardEvent("keydown", { key: "s", ctrlKey: true }))
    ).toBeNull();
  });

  it("禁用（null）：原绑定不再匹配", () => {
    const persistence = usePersistenceStore();
    persistence.settings.shortcuts = { save: null };
    const { matchGlobalKeydown } = useShortcuts();
    expect(
      matchGlobalKeydown(new KeyboardEvent("keydown", { key: "s", ctrlKey: true }))
    ).toBeNull();
  });

  it("运行中修改覆盖 → 实时生效（新绑定立即生效、旧绑定失效，无需重建 composable）", () => {
    const persistence = usePersistenceStore();
    const { matchGlobalKeydown, effective } = useShortcuts();

    // 初始默认：Ctrl+S 匹配 save，Alt+S 未命中
    expect(
      matchGlobalKeydown(new KeyboardEvent("keydown", { key: "s", ctrlKey: true }))
    ).toBe("save");
    expect(
      matchGlobalKeydown(new KeyboardEvent("keydown", { key: "s", altKey: true }))
    ).toBeNull();

    // 运行中修改 settings.shortcuts（模拟设置窗口保存后 loadSettings 覆盖 store）
    // 直接赋值以验证响应式链（settings → overrides computed → matchGlobalKeydown），
    // 避免 updateSettings 内部 saveSettings 在无 Tauri 环境的 invoke 噪音
    persistence.settings.shortcuts = { save: "Alt+S" };

    // 新绑定立即生效
    expect(
      matchGlobalKeydown(new KeyboardEvent("keydown", { key: "s", altKey: true }))
    ).toBe("save");
    // 旧绑定已失效
    expect(
      matchGlobalKeydown(new KeyboardEvent("keydown", { key: "s", ctrlKey: true }))
    ).toBeNull();
    // effective 响应式同步更新
    expect(effective.value.save).toBe("Alt+S");
  });

  it("恢复默认覆盖 → 旧绑定重新生效（实时回退）", () => {
    const persistence = usePersistenceStore();
    persistence.settings.shortcuts = { save: "Alt+S" };
    const { matchGlobalKeydown } = useShortcuts();
    expect(
      matchGlobalKeydown(new KeyboardEvent("keydown", { key: "s", altKey: true }))
    ).toBe("save");

    // 运行中清空覆盖（等价于恢复默认）
    persistence.settings.shortcuts = {};
    expect(
      matchGlobalKeydown(new KeyboardEvent("keydown", { key: "s", ctrlKey: true }))
    ).toBe("save");
    expect(
      matchGlobalKeydown(new KeyboardEvent("keydown", { key: "s", altKey: true }))
    ).toBeNull();
  });

  it("编辑器作用域命令不参与全局匹配", () => {
    const { matchGlobalKeydown } = useShortcuts();
    // Ctrl+1（heading-1 是 editor 作用域）不应被全局匹配
    expect(
      matchGlobalKeydown(new KeyboardEvent("keydown", { key: "1", ctrlKey: true }))
    ).toBeNull();
  });
});
