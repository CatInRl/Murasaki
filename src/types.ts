import { DEFAULT_LOCALE } from "./locales/registry";
import type { AppLocale } from "./locales/registry";
import { PRESENTATION_ZOOM_DEFAULT } from "./utils/presentationZoom";

export type { AppLocale } from "./locales/registry";

/**
 * 文件树节点（与 Rust 端 TreeNode 对齐）
 */
export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: TreeNode[];
  /** 文件大小（字节）；目录或未知时为 undefined */
  size?: number;
}

/**
 * 大纲项（与 Rust 端 OutlineItem 对齐）
 */
export interface OutlineItem {
  level: number; // 1-6
  text: string;
  line: number; // 1-indexed
}

/**
 * 最近打开记录
 */
export interface RecentEntry {
  path: string;
  type: "file" | "folder";
  openedAt: number; // Unix 时间戳（毫秒）
}

/**
 * 侧栏视图类型
 */
export type SidebarView = "files" | "outline";

/**
 * 标签页数据结构
 * - path: 文件绝对路径（null 表示未保存的新文件）
 * - content: 当前编辑器内容
 * - savedContent: 已保存到磁盘的内容快照，用于 dirty 比较
 * - lastMtime: 上次已知文件 mtime（毫秒），用于外部修改检测
 * - isDirty: 是否有未保存修改
 * - hasExternalChange: 是否检测到外部修改（用于冲突处理）
 * - cursor: 光标位置
 * - scroll: 滚动位置
 */
export interface Tab {
  id: string;
  path: string | null;
  content: string;
  savedContent: string;
  lastMtime: number | null;
  isDirty: boolean;
  hasExternalChange: boolean;
  cursor: { line: number; ch: number };
  scroll: { x: number; y: number };
}

/**
 * 跨文件搜索结果（与 Rust 端 search_workspace 返回结构对齐）
 */
export interface SearchResult {
  filePath: string;
  matches: Array<{
    lineNumber: number;
    lineContent: string;
    contextBefore: string[];
    contextAfter: string[];
    /** 命中段（在 lineContent 内的 [start, end)，Rust 端按字符偏移给出，供片段高亮） */
    ranges: [number, number][];
  }>;
}

/**
 * 搜索响应（与 Rust 端 SearchResponse 对齐）
 * - contentResults: 内容匹配结果
 * - filenameResults: 文件名匹配结果（仅路径字符串）
 * - truncated: 是否因达到结果上限而被截断（前端用于提示「结果已截断，请细化查询」）
 */
export interface SearchResponse {
  contentResults: SearchResult[];
  filenameResults: string[];
  truncated: boolean;
}

/**
 * 搜索进度事件 payload（与 Rust 端 SearchProgressEvent 对齐）
 * 通过 `search-progress` Tauri 事件推送给前端
 */
export interface SearchProgressEvent {
  scannedFiles: number;
  totalFiles: number;
  matchedFiles: number;
  matchedCount: number;
  cancelToken: string;
}

/**
 * 搜索结果增量事件 payload（与 Rust 端 SearchResultChunkEvent 对齐）
 * 通过 `search-result-chunk` Tauri 事件推送给前端，每命中一个文件发出一次
 */
export interface SearchResultChunkEvent {
  cancelToken: string;
  result: SearchResult | null;
  filenameMatch: string | null;
}

/**
 * 草稿元数据（与 Rust 端 DraftMeta 对齐）
 */
export interface DraftMeta {
  path: string;
  draftPath: string;
  knownMtime: number;
  savedAt: number;
}

/**
 * 用于 tabs.json 持久化的精简 Tab 结构
 */
export interface PersistedTab {
  path: string | null;
  content: string;
  lastMtime: number | null;
  cursor: { line: number; ch: number };
  scroll: { x: number; y: number };
}

/**
 * tabs.json 文件结构
 */
export interface TabsState {
  tabs: PersistedTab[];
  activeIndex: number;
}

/**
 * settings.json 文件结构
 */
export type ReadingFontPreset = "a" | "b" | "c" | "d";

/**
 * 阅读字体 4 档预设的 font-family 栈。
 * 用于替换 --murasaki-font-reading 变量的取值，保证预览与 WYSIWYG 一致。
 */
export const READING_FONT_PRESETS: Record<ReadingFontPreset, string> = {
  a: `"LXGW WenKai", "Noto Serif SC", "SimSun", serif`,
  b: `"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif`,
  c: `"Source Han Serif SC", "SimSun", "Noto Serif SC", serif`,
  d: `"JetBrains Mono", "Cascadia Code", "Consolas", ui-monospace, monospace`,
};

/** 阅读字体预设文案键（与 i18n settings.editor.fontPreset* 对应） */
export const READING_FONT_PRESET_LABELS: Record<ReadingFontPreset, string> = {
  a: "settings.editor.fontPresetA",
  b: "settings.editor.fontPresetB",
  c: "settings.editor.fontPresetC",
  d: "settings.editor.fontPresetD",
};

/**
 * 侧栏长条目（文件树文件名 / 大纲标题）超出宽度时的显示方案
 * - hover：省略号截断，悬停显示完整内容
 * - wrap：自动换行显示完整内容
 */
export type SidebarEntryOverflow = "hover" | "wrap";

/**
 * 显示模式（0.9.0 新增第 4 种「演示模式」）
 * - source：纯源码
 * - split：源码 + 预览分屏
 * - wysiwyg：所见即所得
 * - presentation：仅预览（只读演示，不挂编辑器）
 */
export type EditorMode = "source" | "split" | "wysiwyg" | "presentation";

export interface SettingsState {
  /** UI 模式已固定为浅色（0.5.0 移除深色模式，issue #114） */
  uiMode: "light";
  editorMode: EditorMode;
  showLineNumbers: boolean;
  softWrap: boolean;
  /** 是否显示隐藏文件（以 . 开头的文件/目录） */
  showHiddenFiles: boolean;
  markdownTheme: string;
  sidebarView: SidebarView;
  /** 侧栏宽度（px，可拖拽调整，持久化，默认 260） */
  sidebarWidth: number;
  /** 侧栏是否折叠为细条（持久化） */
  sidebarCollapsed: boolean;
  /** 上次打开的工作区路径（启动时恢复） */
  lastWorkspacePath: string | null;
  /** 启动时自动打开上次工作区（默认关，issue #96） */
  reopenLastWorkspace: boolean;
  /** 编辑器字体大小（px，12-20） */
  editorFontSize: number;
  /** 编辑器行高 */
  editorLineHeight: number;
  /** 编辑器等宽字体族 */
  editorFontFamily: string;
  /** 阅读字体 4 档预设（默认 d：等宽，issue 0.x） */
  editorFontPreset: ReadingFontPreset;
  /** 粘贴图片时默认保存的相对目录 */
  defaultImageDir: string;
  /** 启动时静默检查更新（默认开，ADR-0012） */
  checkUpdatesOnStartup: boolean;
  /** 界面语言（默认 zh-CN，ADR-0013） */
  language: AppLocale;
  /** 侧栏长条目显示方案：hover=省略号+悬停显示完整 / wrap=自动换行 */
  entryOverflowMode: SidebarEntryOverflow;
  /**
   * 中文符号自动转 Markdown 记号（默认开，0.8.0）。
   * 行首输入全角/中文符号后加空格，整串自动转换为 markdown 结构记号。
   * 映射表固定内置（见 editor/fullwidthToMarkdown.ts），设置面板只读展示。
   */
  fullwidthToMarkdown: boolean;
  /**
   * 快捷键覆盖表（commandId → 绑定，null=禁用）。
   * 只存与默认绑定不同的条目；未覆盖的命令回退到注册表默认绑定（resolveShortcut）。
   */
  shortcuts: Record<string, string | null>;
  /**
   * 演示模式缩放百分比（默认 100，范围 50–200，0.9.0）。
   * 仅演示模式生效，属视图状态，不参与设置面板的 draft 比较。
   */
  presentationZoom: number;
}

/**
 * 默认设置
 */
export const DEFAULT_SETTINGS: SettingsState = {
  uiMode: "light",
  editorMode: "split",
  showLineNumbers: true,
  softWrap: true,
  showHiddenFiles: false,
  markdownTheme: "github",
  sidebarView: "files",
  sidebarWidth: 260,
  sidebarCollapsed: false,
  lastWorkspacePath: null,
  reopenLastWorkspace: true,
  editorFontSize: 14,
  editorLineHeight: 1.6,
  editorFontFamily: "JetBrains Mono",
  editorFontPreset: "d",
  defaultImageDir: "assets/images",
  checkUpdatesOnStartup: true,
  language: DEFAULT_LOCALE,
  entryOverflowMode: "hover",
  fullwidthToMarkdown: true,
  shortcuts: {},
  presentationZoom: PRESENTATION_ZOOM_DEFAULT,
};


