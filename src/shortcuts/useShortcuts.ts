/**
 * 快捷键运行时接线
 *
 * - useShortcuts(): Vue composable，读取设置中的快捷键覆盖（overrides），
 *   提供全局 keydown 匹配（matchGlobalKeydown）与有效绑定（effective）。
 * - buildEditorShortcutExtension(overrides): 把编辑器作用域命令的有效绑定
 *   转成 CodeMirror keymap 扩展（含不可自定义的 Enter 引用块换行处理）。
 *
 * 覆盖来源：settings.shortcuts（commandId → 绑定，null=禁用），只存与默认不同的条目；
 * 未覆盖的命令回退到注册表默认绑定（resolveShortcut）。
 */
import { computed } from "vue";
import { Prec, type Extension } from "@codemirror/state";
import { keymap, type KeyBinding } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import { redo, selectAll, undo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { SHORTCUT_COMMANDS, type ShortcutCommand } from "./shortcutRegistry";
import {
  effectiveShortcuts,
  resolveShortcut,
  shortcutMatchesEvent,
  toCmKey,
  type ShortcutOverrides,
} from "./shortcutsLogic";
import { usePersistenceStore } from "../stores/usePersistenceStore";
import {
  handleEnterInBlockquote,
  setHeading,
  toggleBlockquote,
  toggleCodeBlock,
  toggleList,
} from "../composables/useEditorCommands";

/** 编辑器命令执行器：返回 true 表示已处理（CM keymap 约定） */
type EditorCommandRunner = (view: EditorView) => boolean;

/** 把编辑器作用域命令 ID 映射到具体执行函数；非编辑器命令返回 null */
function editorCommandFor(cmd: ShortcutCommand): EditorCommandRunner | null {
  switch (cmd.id) {
    case "undo":
      return undo;
    case "redo":
      return redo;
    case "select-all":
      return selectAll;
    case "find":
    case "replace":
      return (v) => {
        openSearchPanel(v);
        return true;
      };
    case "heading-1":
    case "heading-2":
    case "heading-3":
    case "heading-4":
    case "heading-5":
    case "heading-6": {
      const level = parseInt(cmd.id.split("-")[1], 10);
      return (v) => {
        setHeading(v, level);
        return true;
      };
    }
    case "normal":
      return (v) => {
        setHeading(v, 0);
        return true;
      };
    case "code-block":
      return (v) => {
        toggleCodeBlock(v);
        return true;
      };
    case "blockquote":
      return (v) => {
        toggleBlockquote(v);
        return true;
      };
    case "unordered-list":
      return (v) => {
        toggleList(v, "unordered");
        return true;
      };
    case "ordered-list":
      return (v) => {
        toggleList(v, "ordered");
        return true;
      };
    case "task-list":
      return (v) => {
        toggleList(v, "task");
        return true;
      };
    default:
      return null;
  }
}

/**
 * 构建编辑器快捷键 keymap 扩展。
 * - 不可自定义：Enter 引用块换行处理（始终存在，高优先级）
 * - 可自定义：编辑器作用域命令按有效绑定生成 keymap 项（Prec.highest，
 *   覆盖 defaultKeymap 的同键绑定）；绑定为 null 的命令不生成项（即禁用）
 */
export function buildEditorShortcutExtension(
  overrides: ShortcutOverrides
): Extension {
  const bindings: KeyBinding[] = [
    { key: "Enter", run: (v) => handleEnterInBlockquote(v) },
  ];
  for (const cmd of SHORTCUT_COMMANDS) {
    if (cmd.scope !== "editor") continue;
    const binding = resolveShortcut(overrides, cmd.id);
    if (!binding) continue;
    const cmKey = toCmKey(binding);
    const run = editorCommandFor(cmd);
    if (!cmKey || !run) continue;
    bindings.push({ key: cmKey, preventDefault: true, run });
  }
  return Prec.highest(keymap.of(bindings));
}

/**
 * 快捷键运行时 composable。
 * 读取 settings.shortcuts 覆盖，暴露全局 keydown 匹配器。
 */
export function useShortcuts() {
  const persistence = usePersistenceStore();

  /** 快捷键覆盖表（响应式，设置保存后自动更新） */
  const overrides = computed<ShortcutOverrides>(
    () => persistence.settings.shortcuts ?? {}
  );

  /** 所有命令的有效绑定（id → 规范快捷键或 null） */
  const effective = computed(() => effectiveShortcuts(overrides.value));

  /**
   * 匹配全局作用域快捷键：命中返回命令 ID（由调用方分发到 handleMenuEvent），
   * 未命中返回 null。按注册表登记顺序取首个匹配。
   */
  function matchGlobalKeydown(e: KeyboardEvent): string | null {
    for (const cmd of SHORTCUT_COMMANDS) {
      if (cmd.scope !== "global") continue;
      const binding = resolveShortcut(overrides.value, cmd.id);
      if (binding && shortcutMatchesEvent(binding, e)) return cmd.id;
    }
    return null;
  }

  return { overrides, effective, matchGlobalKeydown };
}
