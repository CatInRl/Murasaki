/**
 * 文件树节点（与 Rust 端 TreeNode 对齐）
 */
export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: TreeNode[];
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
  }>;
}

/**
 * 搜索响应（与 Rust 端 SearchResponse 对齐）
 * - contentResults: 内容匹配结果
 * - filenameResults: 文件名匹配结果（仅路径字符串）
 */
export interface SearchResponse {
  contentResults: SearchResult[];
  filenameResults: string[];
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
export interface SettingsState {
  uiMode: "light" | "dark" | "system";
  editorMode: "split" | "wysiwyg";
  showLineNumbers: boolean;
  softWrap: boolean;
  /** 是否显示隐藏文件（以 . 开头的文件/目录） */
  showHiddenFiles: boolean;
  markdownTheme: string;
  sidebarView: SidebarView;
  /** 上次打开的工作区路径（启动时恢复） */
  lastWorkspacePath: string | null;
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
  lastWorkspacePath: null,
};
