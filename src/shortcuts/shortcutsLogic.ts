/**
 * 快捷键纯逻辑层
 *
 * 不依赖 Tauri / Vue / CodeMirror 的任何运行时，所有函数均为纯函数，
 * 便于单元测试（项目测试哲学：优先测纯逻辑，不测组件实现细节）。
 *
 * 规范快捷键格式："Ctrl+Shift+K" / "F11" / "Ctrl+Tab" / "Ctrl+Shift+]"
 * - 修饰键顺序固定：Ctrl > Shift > Alt
 * - Ctrl 视为主修饰键：匹配 e.ctrlKey 或 e.metaKey（跨平台，macOS 上对应 Cmd）
 */
import {
  SHORTCUT_COMMANDS,
  commandById,
  type ShortcutCommand,
} from "./shortcutRegistry";

// ===== 键名规范化 =====

/** 特殊键名映射（统一大小写后查表） */
const SPECIAL_KEYS: Record<string, string> = {
  " ": "Space",
  space: "Space",
  enter: "Enter",
  return: "Enter",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "ArrowUp",
  arrowup: "ArrowUp",
  down: "ArrowDown",
  arrowdown: "ArrowDown",
  left: "ArrowLeft",
  arrowleft: "ArrowLeft",
  right: "ArrowRight",
  arrowright: "ArrowRight",
  comma: ",",
  period: ".",
  semicolon: ";",
  quote: "'",
  slash: "/",
  backslash: "\\",
  backquote: "`",
  minus: "-",
  equal: "=",
  bracketleft: "[",
  bracketright: "]",
};

/** 归一化单个键名："k"→"K"、"F11"→"F11"、"tab"→"Tab"、"["→"[" */
export function normalizeKeyName(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 0) return trimmed;
  if (trimmed.length === 1) {
    // 单字母统一大写；数字与标点保持原样
    return /[a-z]/i.test(trimmed) ? trimmed.toUpperCase() : trimmed;
  }
  const lower = trimmed.toLowerCase();
  const special = SPECIAL_KEYS[lower];
  if (special) return special;
  // F 键 / Arrow 等：首字母大写
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

// ===== 规范化 / 解析 =====

/** 修饰键别名（统一小写后匹配） */
const MOD_WORDS = [
  "ctrl", "control", "cmd", "command", "meta", "win", "super",
  "shift",
  "alt", "option",
];

/**
 * 拆分一个 "+" 分隔的 token。
 * 若 token 形如 "ctrl-shift-k"（修饰词 + 连字符 + 最终键），按 "-" 拆分；
 * 否则原样返回（此时 token 本身即键，如 "-" 表示减号键）。
 */
function splitHyphenatedToken(token: string): string[] {
  const lower = token.toLowerCase();
  const modGroup = MOD_WORDS.join("|");
  const pattern = new RegExp(`^(${modGroup})(-(${modGroup}))*-.+$`);
  if (pattern.test(lower)) {
    return token.split("-").map((s) => s.trim()).filter(Boolean);
  }
  return [token];
}

/**
 * 规范化快捷键字符串为规范格式。
 * 输入大小写不敏感，分隔符兼容 "+" 与 "-"；仅支持单键 + 可选修饰键。
 * 修饰键顺序按输入保留（去重），保证展示自然（如 "Alt+Shift+S" 不会被重排）。
 * 无效输入返回 null。
 */
export function normalizeShortcut(input: string | null | undefined): string | null {
  if (!input) return null;
  const parts = input
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap(splitHyphenatedToken);
  if (parts.length === 0) return null;

  const mods: string[] = [];
  let key: string | null = null;

  for (const part of parts) {
    const lower = part.toLowerCase();
    let mod: string | null = null;
    if (["ctrl", "control", "cmd", "command", "meta", "win", "super"].includes(lower)) {
      mod = "Ctrl";
    } else if (lower === "shift") {
      mod = "Shift";
    } else if (["alt", "option"].includes(lower)) {
      mod = "Alt";
    }
    if (mod) {
      if (!mods.includes(mod)) mods.push(mod);
    } else if (key === null) {
      key = part;
    } else {
      return null; // 出现多个按键
    }
  }
  if (key === null) return null; // 纯修饰键
  if (key.includes("+") || key.includes("-")) return null; // 残留分隔符 → 无效

  const normalizedKey = normalizeKeyName(key);
  return [...mods, normalizedKey].join("+");
}

/**
 * 规范等价形式的快捷键（修饰键重排为固定顺序 Ctrl > Shift > Alt）。
 * 仅用于相等性比较（冲突检测 / 去重），不做展示。顺序不同但按键相同 → 相同值。
 */
export function canonicalizeShortcut(
  input: string | null | undefined
): string | null {
  const normalized = normalizeShortcut(input);
  const parsed = parseShortcut(normalized);
  if (!parsed) return null;
  const parts: string[] = [];
  if (parsed.ctrl) parts.push("Ctrl");
  if (parsed.shift) parts.push("Shift");
  if (parsed.alt) parts.push("Alt");
  parts.push(parsed.key);
  return parts.join("+");
}

export interface ParsedShortcut {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

/** 解析规范快捷键为结构化对象；无效返回 null */
export function parseShortcut(shortcut: string | null | undefined): ParsedShortcut | null {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return null;
  const parts = normalized.split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  return {
    ctrl: mods.includes("Ctrl"),
    shift: mods.includes("Shift"),
    alt: mods.includes("Alt"),
    key,
  };
}

// ===== 事件匹配 / 录制 =====

/** 判断键盘事件是否匹配某快捷键。Ctrl 视为主修饰键：匹配 ctrlKey 或 metaKey */
export function shortcutMatchesEvent(
  shortcut: string | null | undefined,
  e: KeyboardEvent
): boolean {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return false;
  const primary = e.ctrlKey || e.metaKey;
  if (parsed.ctrl !== primary) return false;
  if (parsed.shift !== e.shiftKey) return false;
  if (parsed.alt !== e.altKey) return false;
  return normalizeKeyName(parsed.key) === normalizeKeyName(e.key);
}

/** 把 keydown 事件转换为规范快捷键字符串（用于录制）；纯修饰键/无按键返回 null */
export function eventToShortcut(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta", "CapsLock"].includes(e.key)) return null;
  const primary = e.ctrlKey || e.metaKey;
  const parts: string[] = [];
  if (primary) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  const key = normalizeKeyName(e.key);
  if (!key) return null;
  parts.push(key);
  return parts.join("+");
}

/** 是否为会产生字符输入的键（字母/数字/标点/空格），用于禁止无修饰键绑定 */
export function isCharacterKey(key: string): boolean {
  if (key === " " || key === "Space") return true;
  if (/^[a-z0-9]$/i.test(key)) return true;
  return key.length === 1 && /[^\w\s]/.test(key);
}

/**
 * 判断某快捷键是否可作为自定义绑定：
 * - 无效/纯修饰键 → false
 * - 字符键（字母/数字/标点/空格）必须带 Ctrl 或 Alt，否则会吞掉打字
 * - 功能/导航/编辑键（F11、Esc、Tab、方向键等）允许单独绑定
 */
export function isUsableShortcut(shortcut: string | null | undefined): boolean {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return false;
  if (parsed.ctrl || parsed.alt) return true;
  return !isCharacterKey(parsed.key);
}

// ===== CodeMirror 键名 =====

/** 单字母转小写（CM 内部对字母大小写不敏感，统一小写最稳妥）；其余原样 */
function cmKeyName(key: string): string {
  return /^[a-z]$/i.test(key) ? key.toLowerCase() : key;
}

/** 转 CodeMirror keymap 键格式："Ctrl+Shift+K" → "Mod-Shift-K"（Mod=Cmd on mac / Ctrl 其余） */
export function toCmKey(shortcut: string | null | undefined): string | null {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return null;
  const parts: string[] = [];
  if (parsed.ctrl) parts.push("Mod");
  if (parsed.shift) parts.push("Shift");
  if (parsed.alt) parts.push("Alt");
  parts.push(cmKeyName(parsed.key));
  return parts.join("-");
}

// ===== 有效绑定解析 =====

/** 快捷键覆盖表：commandId → 绑定（null 表示禁用该命令的快捷键） */
export type ShortcutOverrides = Record<string, string | null>;

/**
 * 解析某命令的有效绑定：
 * - overrides 中显式存在（含 null=禁用）→ 采用覆盖值
 * - 否则 → 命令默认绑定
 */
export function resolveShortcut(
  overrides: ShortcutOverrides,
  commandId: string
): string | null {
  if (Object.prototype.hasOwnProperty.call(overrides, commandId)) {
    return normalizeShortcut(overrides[commandId]);
  }
  return commandById(commandId)?.defaultShortcut ?? null;
}

/** 计算所有命令的有效绑定（id → 规范快捷键或 null） */
export function effectiveShortcuts(
  overrides: ShortcutOverrides
): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const cmd of SHORTCUT_COMMANDS) {
    result[cmd.id] = resolveShortcut(overrides, cmd.id);
  }
  return result;
}

/** 某命令当前绑定是否等于默认绑定 */
export function isDefaultShortcut(
  overrides: ShortcutOverrides,
  commandId: string
): boolean {
  const resolved = resolveShortcut(overrides, commandId);
  const def = commandById(commandId)?.defaultShortcut ?? null;
  return normalizeShortcut(resolved) === normalizeShortcut(def);
}

/**
 * 写入单个命令的绑定覆盖，返回新覆盖表（不 mutate 输入）：
 * - binding 与默认绑定相同 → 删除覆盖（保持覆盖表最小，只存非默认条目）
 * - binding 为 null（禁用）→ 记录 null
 * - 否则记录规范化后的绑定
 */
export function setShortcutOverride(
  overrides: ShortcutOverrides,
  commandId: string,
  binding: string | null
): ShortcutOverrides {
  const def = commandById(commandId)?.defaultShortcut ?? null;
  const normalized = normalizeShortcut(binding);
  const next = { ...overrides };
  if (normalizeShortcut(def) === normalized) {
    delete next[commandId];
  } else {
    next[commandId] = normalized;
  }
  return next;
}

/** 删除某命令的绑定覆盖（恢复默认绑定），返回新覆盖表（不 mutate 输入） */
export function resetShortcutOverride(
  overrides: ShortcutOverrides,
  commandId: string
): ShortcutOverrides {
  const next = { ...overrides };
  delete next[commandId];
  return next;
}

// ===== 冲突检测 =====

export interface ShortcutConflict {
  shortcut: string;
  commands: ShortcutCommand[];
}

/** 检测绑定冲突：返回共享同一有效快捷键的命令组（按命令登记顺序） */
export function detectConflicts(overrides: ShortcutOverrides): ShortcutConflict[] {
  const map = new Map<string, ShortcutCommand[]>();
  for (const cmd of SHORTCUT_COMMANDS) {
    const binding = resolveShortcut(overrides, cmd.id);
    if (!binding) continue;
    // 用规范等价形式做 key：修饰键顺序不同的同一组合视为冲突
    const key = canonicalizeShortcut(binding);
    if (!key) continue;
    const list = map.get(key);
    if (list) list.push(cmd);
    else map.set(key, [cmd]);
  }
  return [...map.entries()]
    .filter(([, cmds]) => cmds.length > 1)
    .map(([shortcut, commands]) => ({ shortcut, commands }));
}

/** 展示用：快捷键字符串（规范格式），无绑定返回 null（面板显示"未设置"） */
export function formatShortcut(shortcut: string | null | undefined): string | null {
  return normalizeShortcut(shortcut);
}
