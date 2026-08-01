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
export interface SettingsState {
  uiMode: "light" | "dark" | "system";
  editorMode: "source" | "split" | "wysiwyg";
  showLineNumbers: boolean;
  softWrap: boolean;
  /** 是否显示隐藏文件（以 . 开头的文件/目录） */
  showHiddenFiles: boolean;
  markdownTheme: string;
  sidebarView: SidebarView;
  /** 上次打开的工作区路径（启动时恢复） */
  lastWorkspacePath: string | null;
  /** 是否显示 Agent 面板（默认开） */
  showAgentPanel: boolean;
  /** 编辑器字体大小（px，12-20） */
  editorFontSize: number;
  /** 编辑器行高 */
  editorLineHeight: number;
  /** 编辑器等宽字体族 */
  editorFontFamily: string;
  /** 粘贴图片时默认保存的相对目录 */
  defaultImageDir: string;
  /** Agent 循环轮数上限（默认 15） */
  aiAgentMaxRounds: number;
  /** 单次请求 token 上限（默认 16384） */
  aiSingleRequestTokenLimit: number;
  /** 累计 token 软上限（默认 51200） */
  aiCumulativeTokenSoftLimit: number;
  /** propose_replace 二次确认阈值（默认 50 行） */
  aiProposeReplaceConfirmThreshold: number;
  /** 启动时静默检查更新（默认开，ADR-0012） */
  checkUpdatesOnStartup: boolean;
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
  showAgentPanel: true,
  editorFontSize: 14,
  editorLineHeight: 1.6,
  editorFontFamily: "JetBrains Mono",
  defaultImageDir: "assets/images",
  aiAgentMaxRounds: 15,
  aiSingleRequestTokenLimit: 16384,
  aiCumulativeTokenSoftLimit: 51200,
  aiProposeReplaceConfirmThreshold: 50,
  checkUpdatesOnStartup: true,
};

/**
 * AI Provider 配置（与 Rust 端 AiProvider 对齐）
 * 注意：apiKey 明文不在前端持久化，仅通过 get_api_key 命令按需获取
 */
export interface AiProvider {
  id: string;
  name: string;
  type: "deepseek" | "openai" | "anthropic" | "custom";
  baseUrl: string;
  model: string;
  /** 是否为活动 provider（仅一个可为 true） */
  isActive: boolean;
}

/**
 * AI Provider 预设（用于一键填充）
 */
export interface AiProviderPreset {
  type: AiProvider["type"];
  label: string;
  baseUrl: string;
  model: string;
}

/**
 * DeepSeek / OpenAI / Anthropic 默认预设
 */
export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    type: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
  },
  {
    type: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com",
    model: "gpt-4o-mini",
  },
  {
    type: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-5-20250929",
  },
  {
    type: "custom",
    label: "自定义",
    baseUrl: "",
    model: "",
  },
];

// ===== Agent 对话类型 =====

/**
 * Agent 对话消息
 * 后续 ticket 会扩展 contextSnapshot / toolCalls / toolResult 字段
 */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** 是否被中断（AbortController.abort 触发） */
  interrupted?: boolean;
  /** 创建时间戳（ms） */
  createdAt: number;
  /** 该 user 消息发送时的文档上下文快照 */
  contextSnapshot?: ContextSnapshot;
  /** assistant 消息的工具调用列表 */
  toolCalls?: ToolCallEntry[];
}

/** 文档上下文快照（每条 user 消息发送时捕获） */
export interface ContextSnapshot {
  docPath: string | null;
  cursor: { line: number; ch: number } | null;
  selection: { from: number; to: number; text: string } | null;
}

/** 工具调用条目（UI 可见） */
export interface ToolCallEntry {
  id: string;
  name: string;
  /** 调用参数（原始 JSON 字符串） */
  arguments: string;
  /** 调用状态 */
  status: "calling" | "done" | "error";
  /** 摘要（如「已获取 286 字符」「L15-17」） */
  summary?: string;
  /** 工具结果（结构化 {ok, data|error}） */
  result?: { ok: boolean; data?: unknown; error?: string };
  /** 摘要参数（展开时显示） */
  parsedArgs?: unknown;
}

/**
 * Agent 状态机
 */
export type AgentStatus = "idle" | "thinking" | "cancelled" | "error";

// ===== 新文件提议（Ticket #24: propose_new_file）=====

/**
 * 新文件提议
 *
 * 与 inline Proposal 不同：
 * - 不绑定编辑器位置（不进入 CM6 StateField）
 * - 在 Agent 面板底部以卡片形式展示
 * - 用户接受后才尝试写文件（冲突时走 T2 dialog）
 */
export interface NewFileProposal {
  id: string;
  /** 相对工作区的目标路径（如 "notes/new.md"） */
  path: string;
  /** 文件内容 */
  content: string;
  /** 简短描述（agent 提供） */
  label: string;
  /** 行数 */
  lineCount: number;
  /** 状态 */
  status: NewFileProposalStatus;
  /** 写入后的绝对路径（仅 status === "written" 时有值） */
  writtenPath?: string;
  /** 错误信息（status === "error" 时有值） */
  error?: string;
}

export type NewFileProposalStatus =
  | "pending" // 等待用户接受/拒绝
  | "accepted" // 用户已接受（写入中或已写入）
  | "rejected" // 用户已拒绝
  | "written" // 已成功写入磁盘
  | "error"; // 写入失败（如路径无效、冲突未解决）

