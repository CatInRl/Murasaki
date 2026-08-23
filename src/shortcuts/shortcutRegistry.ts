/**
 * 快捷键命令注册表 —— 单一事实源（Single Source of Truth）
 *
 * 所有可被用户自定义的快捷键命令都必须在 SHORTCUT_COMMANDS 中登记，
 * 并持有其默认绑定。本注册表只描述"命令是什么 + 默认绑定"，不包含执行逻辑；
 * 执行逻辑保留在各自的归属处：
 * - global 作用域 → useShortcuts.matchGlobalKeydown → useCommands.handleMenuEvent 分发
 * - editor 作用域 → buildEditorShortcutExtension（见 useShortcuts.ts）映射到
 *   useEditorCommands 的格式化命令 / @codemirror/commands 的标准编辑命令
 *
 * 规范快捷键格式："Ctrl+Shift+K" / "F11" / "Ctrl+Tab" / "Ctrl+Shift+]"
 * 修饰键顺序固定为 Ctrl > Shift > Alt；Ctrl 视为主修饰键（匹配 ctrlKey 或 metaKey，
 * 兼容 macOS 的 Cmd）。
 */

export type ShortcutCategory = "file" | "edit" | "paragraph" | "view" | "agent";

/** 命令作用域：global=窗口级 keydown 处理；editor=CodeMirror keymap 处理 */
export type ShortcutScope = "global" | "editor";

export interface ShortcutCommand {
  /** 命令 ID（与原生菜单项 ID 一致，便于 handleMenuEvent 分发） */
  id: string;
  /** 命令名称的 i18n key（settings.shortcuts.*） */
  labelKey: string;
  /** 展示分组 */
  category: ShortcutCategory;
  /** 默认快捷键（规范格式）；null=默认无绑定（用户可自行分配） */
  defaultShortcut: string | null;
  /** 作用域 */
  scope: ShortcutScope;
}

export const SHORTCUT_COMMANDS: ShortcutCommand[] = [
  // ===== 文件（global）=====
  { id: "new-file", labelKey: "settings.shortcuts.newFile", category: "file", defaultShortcut: "Ctrl+N", scope: "global" },
  { id: "new-folder", labelKey: "settings.shortcuts.newFolder", category: "file", defaultShortcut: null, scope: "global" },
  { id: "open-file", labelKey: "settings.shortcuts.openFile", category: "file", defaultShortcut: "Ctrl+O", scope: "global" },
  { id: "open-folder", labelKey: "settings.shortcuts.openFolder", category: "file", defaultShortcut: "Ctrl+Shift+O", scope: "global" },
  { id: "save", labelKey: "settings.shortcuts.save", category: "file", defaultShortcut: "Ctrl+S", scope: "global" },
  { id: "save-as", labelKey: "settings.shortcuts.saveAs", category: "file", defaultShortcut: "Ctrl+Shift+S", scope: "global" },
  { id: "export-html", labelKey: "settings.shortcuts.exportHtml", category: "file", defaultShortcut: null, scope: "global" },
  { id: "export-pdf", labelKey: "settings.shortcuts.exportPdf", category: "file", defaultShortcut: null, scope: "global" },
  { id: "copy-rich-text", labelKey: "settings.shortcuts.copyRichText", category: "file", defaultShortcut: null, scope: "global" },
  { id: "close-tab", labelKey: "settings.shortcuts.closeTab", category: "file", defaultShortcut: "Ctrl+W", scope: "global" },
  { id: "reload-file", labelKey: "settings.shortcuts.reloadFile", category: "file", defaultShortcut: "Ctrl+R", scope: "global" },
  { id: "close-workspace", labelKey: "settings.shortcuts.closeWorkspace", category: "file", defaultShortcut: null, scope: "global" },
  { id: "settings", labelKey: "settings.shortcuts.settings", category: "file", defaultShortcut: null, scope: "global" },
  { id: "quit", labelKey: "settings.shortcuts.quit", category: "file", defaultShortcut: "Ctrl+Q", scope: "global" },

  // ===== 编辑（默认在编辑器内生效）=====
  // 注：cut/copy/paste 是浏览器原生剪贴板操作，CM6 不暴露对应命令，故不列入可自定义清单
  { id: "undo", labelKey: "settings.shortcuts.undo", category: "edit", defaultShortcut: "Ctrl+Z", scope: "editor" },
  { id: "redo", labelKey: "settings.shortcuts.redo", category: "edit", defaultShortcut: "Ctrl+Y", scope: "editor" },
  { id: "select-all", labelKey: "settings.shortcuts.selectAll", category: "edit", defaultShortcut: "Ctrl+A", scope: "editor" },
  { id: "find", labelKey: "settings.shortcuts.find", category: "edit", defaultShortcut: "Ctrl+F", scope: "editor" },
  { id: "replace", labelKey: "settings.shortcuts.replace", category: "edit", defaultShortcut: "Ctrl+H", scope: "editor" },
  { id: "find-in-files", labelKey: "settings.shortcuts.findInFiles", category: "edit", defaultShortcut: "Ctrl+Shift+F", scope: "global" },

  // ===== 段落格式化（editor）=====
  { id: "heading-1", labelKey: "settings.shortcuts.heading1", category: "paragraph", defaultShortcut: "Ctrl+1", scope: "editor" },
  { id: "heading-2", labelKey: "settings.shortcuts.heading2", category: "paragraph", defaultShortcut: "Ctrl+2", scope: "editor" },
  { id: "heading-3", labelKey: "settings.shortcuts.heading3", category: "paragraph", defaultShortcut: "Ctrl+3", scope: "editor" },
  { id: "heading-4", labelKey: "settings.shortcuts.heading4", category: "paragraph", defaultShortcut: "Ctrl+4", scope: "editor" },
  { id: "heading-5", labelKey: "settings.shortcuts.heading5", category: "paragraph", defaultShortcut: "Ctrl+5", scope: "editor" },
  { id: "heading-6", labelKey: "settings.shortcuts.heading6", category: "paragraph", defaultShortcut: "Ctrl+6", scope: "editor" },
  { id: "normal", labelKey: "settings.shortcuts.normal", category: "paragraph", defaultShortcut: "Ctrl+0", scope: "editor" },
  { id: "code-block", labelKey: "settings.shortcuts.codeBlock", category: "paragraph", defaultShortcut: "Ctrl+Shift+K", scope: "editor" },
  { id: "blockquote", labelKey: "settings.shortcuts.blockquote", category: "paragraph", defaultShortcut: "Ctrl+Shift+Q", scope: "editor" },
  { id: "unordered-list", labelKey: "settings.shortcuts.unorderedList", category: "paragraph", defaultShortcut: "Ctrl+Shift+]", scope: "editor" },
  { id: "ordered-list", labelKey: "settings.shortcuts.orderedList", category: "paragraph", defaultShortcut: "Ctrl+Shift+[", scope: "editor" },
  { id: "task-list", labelKey: "settings.shortcuts.taskList", category: "paragraph", defaultShortcut: "Ctrl+Shift+X", scope: "editor" },

  // ===== 视图（global）=====
  { id: "toggle-sidebar", labelKey: "settings.shortcuts.toggleSidebar", category: "view", defaultShortcut: "Ctrl+Shift+E", scope: "global" },
  { id: "toggle-outline", labelKey: "settings.shortcuts.toggleOutline", category: "view", defaultShortcut: "Ctrl+Shift+M", scope: "global" },
  { id: "switch-tab-next", labelKey: "settings.shortcuts.switchTabNext", category: "view", defaultShortcut: "Ctrl+Tab", scope: "global" },
  { id: "switch-tab-prev", labelKey: "settings.shortcuts.switchTabPrev", category: "view", defaultShortcut: "Ctrl+Shift+Tab", scope: "global" },
  { id: "fullscreen", labelKey: "settings.shortcuts.fullscreen", category: "view", defaultShortcut: "F11", scope: "global" },
  { id: "toggle-statusbar", labelKey: "settings.shortcuts.toggleStatusbar", category: "view", defaultShortcut: "Alt+Shift+S", scope: "global" },
];

/** 默认绑定映射（commandId → 规范快捷键或 null），供注册表使用者快速读取 */
export const DEFAULT_SHORTCUTS: Record<string, string | null> = Object.fromEntries(
  SHORTCUT_COMMANDS.map((c) => [c.id, c.defaultShortcut])
);

const COMMAND_BY_ID = new Map<string, ShortcutCommand>(
  SHORTCUT_COMMANDS.map((c) => [c.id, c])
);

/** 按 ID 查询命令（O(1)），未登记返回 undefined */
export function commandById(id: string): ShortcutCommand | undefined {
  return COMMAND_BY_ID.get(id);
}

/** 命令展示分组顺序（设置面板按此排序） */
export const CATEGORY_ORDER: ShortcutCategory[] = ["file", "edit", "paragraph", "view", "agent"];
