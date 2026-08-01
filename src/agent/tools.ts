/**
 * Agent 工具注册表
 *
 * Ticket #21: 4 个 CM6 状态类工具
 *   - get_current_document
 *   - get_selection
 *   - get_visible_range
 *   - get_outline
 *
 * 工具命名使用 snake_case，描述用英文，非严格 schema，
 * 前端中间件参数校验，结构化错误 {ok, data|error}
 */

import { invoke } from "@tauri-apps/api/core";
import { useProposalsStore } from "../stores/useProposalsStore";
import { i18n } from "../i18n";
import type { Proposal } from "./proposals";

const t = i18n.global.t.bind(i18n.global);

/** 工具元数据（发送给 LLM 的 function 定义） */
export interface ToolMetadata {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/** 工具执行上下文 */
export interface ToolContext {
  /** 获取当前 EditorView */
  getEditorView: () => unknown;
  /** 当前文档路径 */
  getDocPath: () => string | null;
  /** 当前工作区根路径（无工作区时为 null） */
  getWorkspacePath: () => string | null;
  /** propose_replace 二次确认阈值（来自 SettingsState.aiProposeReplaceConfirmThreshold） */
  getProposeReplaceConfirmThreshold: () => number;
}

/** 工具结果 */
export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** 工具定义 */
export interface ToolDef {
  metadata: ToolMetadata;
  /** 执行函数，args 为已 parse 的参数对象 */
  execute: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
  /** 从结果生成摘要 */
  summarize?: (result: ToolResult) => string;
}

/** 8K 字符截断阈值 */
const MAX_CONTENT_CHARS = 8192;

/** 截断文本 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n... [truncated]";
}

/** 简单 frontmatter 提取 */
function extractFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return fm;
}

// ===== get_current_document =====
const getCurrentDocument: ToolDef = {
  metadata: {
    type: "function",
    function: {
      name: "get_current_document",
      description: "Get the current document content, path, cursor position, selection, and frontmatter. Content is truncated at 8K chars.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  async execute(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const view = ctx.getEditorView() as {
      state: { doc: { toString: () => string; length: number }; selection: { main: { from: number; to: number; empty: boolean } } };
      lineBlockAt: (pos: number) => { from: number; to: number };
    } | null;
    if (!view) {
      return { ok: false, error: "No active editor" };
    }
    const docPath = ctx.getDocPath();
    const fullContent = view.state.doc.toString();
    const content = truncate(fullContent, MAX_CONTENT_CHARS);
    const sel = view.state.selection.main;
    const cursorPos = sel.from;
    // 计算 cursor 行列
    const line = fullContent.slice(0, cursorPos).split("\n").length;
    const lineStart = fullContent.lastIndexOf("\n", cursorPos - 1) + 1;
    const ch = cursorPos - lineStart;
    return {
      ok: true,
      data: {
        docPath,
        content,
        truncated: fullContent.length > MAX_CONTENT_CHARS,
        cursor: { line, ch },
        selection: sel.empty ? null : { from: sel.from, to: sel.to, text: fullContent.slice(sel.from, sel.to) },
        frontmatter: extractFrontmatter(fullContent),
      },
    };
  },
  summarize(result: ToolResult): string {
    if (!result.ok) return result.error ?? t("agent.tools.unknownError");
    const data = result.data as { content?: string; truncated?: boolean };
    const len = data.content?.length ?? 0;
    return data.truncated ? t("agent.tools.docCharsTruncated", { count: len }) : t("agent.tools.docChars", { count: len });
  },
};

// ===== get_selection =====
const getSelection: ToolDef = {
  metadata: {
    type: "function",
    function: {
      name: "get_selection",
      description: "Get the current text selection in the editor. Returns null if no selection.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  async execute(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const view = ctx.getEditorView() as {
      state: { doc: { toString: () => string }; selection: { main: { from: number; to: number; empty: boolean } } };
    } | null;
    if (!view) {
      return { ok: false, error: "No active editor" };
    }
    const sel = view.state.selection.main;
    if (sel.empty) {
      return { ok: true, data: null };
    }
    const text = view.state.doc.toString().slice(sel.from, sel.to);
    return { ok: true, data: { from: sel.from, to: sel.to, text } };
  },
  summarize(result: ToolResult): string {
    if (!result.ok) return result.error ?? t("agent.tools.unknownError");
    if (result.data === null) return t("agent.tools.noSelection");
    const data = result.data as { text?: string };
    return t("agent.tools.selectionChars", { count: data.text?.length ?? 0 });
  },
};

// ===== get_visible_range =====
const getVisibleRange: ToolDef = {
  metadata: {
    type: "function",
    function: {
      name: "get_visible_range",
      description: "Get the currently visible line range in the editor.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  async execute(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const view = ctx.getEditorView() as {
      state: { doc: { toString: () => string; length: number } };
      lineBlockAt: (pos: number) => { from: number; to: number };
      scrollDOM: { scrollTop: number; clientHeight: number };
      contentDOM: HTMLElement;
    } | null;
    if (!view) {
      return { ok: false, error: "No active editor" };
    }
    // 计算可见区域
    const docText = view.state.doc.toString();
    const lines = docText.split("\n");
    let fromLine = 1;
    let toLine = lines.length;
    // 简单实现：通过 scrollDOM 位置估算
    try {
      const scrollTop = view.scrollDOM.scrollTop;
      const scrollHeight = view.scrollDOM.clientHeight;
      // 找到第一个可见行
      let pos = 0;
      for (let i = 0; i < lines.length; i++) {
        const block = view.lineBlockAt(pos);
        if (block.from >= scrollTop) {
          fromLine = i + 1;
          break;
        }
        pos += lines[i].length + 1;
      }
      // 找到最后一个可见行
      pos = docText.length;
      for (let i = lines.length - 1; i >= 0; i--) {
        const block = view.lineBlockAt(pos);
        if (block.to <= scrollTop + scrollHeight) {
          toLine = i + 1;
          break;
        }
        pos -= lines[i].length + 1;
      }
    } catch {
      // 回退到全文范围
    }
    return { ok: true, data: { fromLine, toLine } };
  },
  summarize(result: ToolResult): string {
    if (!result.ok) return result.error ?? t("agent.tools.unknownError");
    const data = result.data as { fromLine?: number; toLine?: number };
    return `L${data.fromLine}-${data.toLine}`;
  },
};

// ===== get_outline =====
const getOutline: ToolDef = {
  metadata: {
    type: "function",
    function: {
      name: "get_outline",
      description: "Get the outline (headings) of the current document. Requires a saved file path.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  async execute(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const docPath = ctx.getDocPath();
    if (!docPath) {
      return { ok: false, error: "No file path (unsaved document)" };
    }
    try {
      const items = await invoke<unknown[]>("parse_outline", { path: docPath });
      return { ok: true, data: items };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  summarize(result: ToolResult): string {
    if (!result.ok) return result.error ?? t("agent.tools.unknownError");
    const items = result.data as unknown[];
    return t("agent.tools.outlineCount", { count: items?.length ?? 0 });
  },
};

// ===== list_files (Ticket #22: 文件类工具) =====
const listFiles: ToolDef = {
  metadata: {
    type: "function",
    function: {
      name: "list_files",
      description: "List all Markdown files in the workspace as relative paths (forward slash, excludes assets/ directory). Requires an open workspace.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  async execute(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const workspace = ctx.getWorkspacePath();
    if (!workspace) {
      return { ok: false, error: "No workspace open" };
    }
    try {
      const files = await invoke<string[]>("agent_list_files", { workspace });
      return { ok: true, data: { files } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  summarize(result: ToolResult): string {
    if (!result.ok) return result.error ?? t("agent.tools.unknownError");
    const data = result.data as { files?: string[] };
    return t("agent.tools.filesCount", { count: data.files?.length ?? 0 });
  },
};

// ===== read_file (Ticket #22: 文件类工具) =====
const readFile: ToolDef = {
  metadata: {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a Markdown file's content from the workspace. Content is truncated at 4K chars. Path must be relative to the workspace root.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to the file (e.g., 'intro.md' or 'sub/deep.md'). Must be within the workspace.",
          },
        },
        required: ["path"],
      },
    },
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const workspace = ctx.getWorkspacePath();
    if (!workspace) {
      return { ok: false, error: "No workspace open" };
    }
    const { path } = (args || {}) as { path?: string };
    if (!path || typeof path !== "string") {
      return { ok: false, error: "missing required parameter: path" };
    }
    try {
      const result = await invoke<{
        docPath: string;
        content: string;
        contentHash: string;
        contentLength: number;
        truncated: boolean;
      }>("agent_read_file", { workspace, path });
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  summarize(result: ToolResult): string {
    if (!result.ok) return result.error ?? t("agent.tools.unknownError");
    const data = result.data as { contentLength?: number; truncated?: boolean };
    const len = data.contentLength ?? 0;
    return data.truncated ? t("agent.tools.readCharsTruncated", { count: len }) : t("agent.tools.readChars", { count: len });
  },
};

// ===== search_across_files (Ticket #22: 文件类工具) =====
const searchAcrossFiles: ToolDef = {
  metadata: {
    type: "function",
    function: {
      name: "search_across_files",
      description: "Search for a keyword or regex pattern across all Markdown files in the workspace. Case-insensitive by default. Results include line number, matched line, and 2 lines of context before/after. Results are truncated at 4K chars.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search keyword or regex pattern",
          },
          is_regex: {
            type: "boolean",
            description: "Whether to treat the query as a regex pattern (default: false)",
          },
        },
        required: ["query"],
      },
    },
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const workspace = ctx.getWorkspacePath();
    if (!workspace) {
      return { ok: false, error: "No workspace open" };
    }
    const { query, is_regex } = (args || {}) as { query?: string; is_regex?: boolean };
    if (query == null || typeof query !== "string") {
      return { ok: false, error: "missing required parameter: query" };
    }
    try {
      const result = await invoke<{
        hits: Array<{
          filePath: string;
          lineNumber: number;
          lineContent: string;
          contextBefore: string[];
          contextAfter: string[];
        }>;
        totalHits: number;
        truncated: boolean;
      }>("agent_search_files", {
        workspace,
        query,
        isRegex: is_regex ?? false,
      });
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  summarize(result: ToolResult): string {
    if (!result.ok) return result.error ?? t("agent.tools.unknownError");
    const data = result.data as { totalHits?: number; truncated?: boolean };
    const total = data.totalHits ?? 0;
    return data.truncated ? t("agent.tools.searchHitsTruncated", { count: total }) : t("agent.tools.searchHits", { count: total });
  },
};

// ===== propose_insert (Ticket #23: 提议类工具) =====
const proposeInsert: ToolDef = {
  metadata: {
    type: "function",
    function: {
      name: "propose_insert",
      description: "Propose inserting text at a specific position in the current document. The user can accept or reject the proposal. Position is a character offset from the start of the document.",
      parameters: {
        type: "object",
        properties: {
          from: {
            type: "number",
            description: "Character offset where to insert the text (0 = beginning of document)",
          },
          content: {
            type: "string",
            description: "The text content to insert",
          },
          label: {
            type: "string",
            description: "Short label for the proposal (e.g., '插入段落' or 'Add import')",
          },
        },
        required: ["from", "content", "label"],
      },
    },
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const view = ctx.getEditorView() as {
      state: { doc: { length: number } };
    } | null;
    if (!view) {
      return { ok: false, error: "No active editor" };
    }
    const { from, content, label } = (args || {}) as {
      from?: number;
      content?: string;
      label?: string;
    };
    if (typeof from !== "number" || from < 0) {
      return { ok: false, error: "invalid parameter: from must be a non-negative number" };
    }
    if (typeof content !== "string") {
      return { ok: false, error: "invalid parameter: content must be a string" };
    }
    if (typeof label !== "string" || !label.trim()) {
      return { ok: false, error: "invalid parameter: label is required" };
    }
    if (from > view.state.doc.length) {
      return { ok: false, error: `from (${from}) exceeds document length (${view.state.doc.length})` };
    }
    try {
      const proposalId = `prop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const lineCount = content.split("\n").length;
      const proposal: Proposal = {
        id: proposalId,
        type: "insert",
        from,
        to: from,
        content,
        status: "pending",
        lineCount,
        label,
      };
      const proposalsStore = useProposalsStore();
      proposalsStore.addProposal(proposal);
      return { ok: true, data: { proposalId, type: "insert", from, lineCount } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  summarize(result: ToolResult): string {
    if (!result.ok) return result.error ?? t("agent.tools.unknownError");
    const data = result.data as { lineCount?: number };
    return t("agent.tools.insertLines", { count: data.lineCount ?? 0 });
  },
};

// ===== propose_replace (Ticket #23: 提议类工具) =====
const proposeReplace: ToolDef = {
  metadata: {
    type: "function",
    function: {
      name: "propose_replace",
      description: "Propose replacing a range of text in the current document. The user can accept or reject the proposal. Positions are character offsets from the start of the document. If the replacement exceeds the configured line threshold (default 50, set via AI advanced params), the user will be asked for secondary confirmation before accepting.",
      parameters: {
        type: "object",
        properties: {
          from: {
            type: "number",
            description: "Character offset where the replacement starts (inclusive)",
          },
          to: {
            type: "number",
            description: "Character offset where the replacement ends (exclusive)",
          },
          content: {
            type: "string",
            description: "The new text content to replace the old range with",
          },
          label: {
            type: "string",
            description: "Short label for the proposal (e.g., '重写段落' or 'Fix typo')",
          },
        },
        required: ["from", "to", "content", "label"],
      },
    },
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const view = ctx.getEditorView() as {
      state: { doc: { length: number } };
    } | null;
    if (!view) {
      return { ok: false, error: "No active editor" };
    }
    const { from, to, content, label } = (args || {}) as {
      from?: number;
      to?: number;
      content?: string;
      label?: string;
    };
    if (typeof from !== "number" || from < 0) {
      return { ok: false, error: "invalid parameter: from must be a non-negative number" };
    }
    if (typeof to !== "number" || to < from) {
      return { ok: false, error: "invalid parameter: to must be >= from" };
    }
    if (typeof content !== "string") {
      return { ok: false, error: "invalid parameter: content must be a string" };
    }
    if (typeof label !== "string" || !label.trim()) {
      return { ok: false, error: "invalid parameter: label is required" };
    }
    if (to > view.state.doc.length) {
      return { ok: false, error: `to (${to}) exceeds document length (${view.state.doc.length})` };
    }
    try {
      const proposalId = `prop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const lineCount = content.split("\n").length;
      const proposal: Proposal = {
        id: proposalId,
        type: "replace",
        from,
        to,
        content,
        status: "pending",
        lineCount,
        label,
      };
      const proposalsStore = useProposalsStore();
      proposalsStore.addProposal(proposal);
      return {
        ok: true,
        data: {
          proposalId,
          type: "replace",
          from,
          to,
          lineCount,
          requiresConfirmation: lineCount > ctx.getProposeReplaceConfirmThreshold(),
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  summarize(result: ToolResult): string {
    if (!result.ok) return result.error ?? t("agent.tools.unknownError");
    const data = result.data as { lineCount?: number; requiresConfirmation?: boolean };
    const lines = data.lineCount ?? 0;
    if (data.requiresConfirmation) {
      return t("agent.tools.replaceLinesConfirm", { count: lines });
    }
    return t("agent.tools.replaceLines", { count: lines });
  },
};

// ===== propose_new_file (Ticket #24: 新文件提议) =====
const proposeNewFile: ToolDef = {
  metadata: {
    type: "function",
    function: {
      name: "propose_new_file",
      description:
        "Propose creating a new Markdown file in the workspace. The user can accept or reject the proposal. The path must be relative to the workspace root and use forward slashes (e.g., 'notes/new.md'). If the file already exists, the user will be asked to overwrite, rename, or cancel.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Relative path for the new file (e.g., 'notes/today.md'). Must end with .md/.markdown/.mdown/.mkd.",
          },
          content: {
            type: "string",
            description: "The full content of the new file",
          },
          label: {
            type: "string",
            description:
              "Short label for the proposal (e.g., '创建 meeting-notes.md' or 'Add README')",
          },
        },
        required: ["path", "content", "label"],
      },
    },
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const workspace = ctx.getWorkspacePath();
    if (!workspace) {
      return { ok: false, error: "No workspace open" };
    }
    const { path, content, label } = (args || {}) as {
      path?: string;
      content?: string;
      label?: string;
    };
    if (typeof path !== "string" || !path.trim()) {
      return { ok: false, error: "invalid parameter: path is required" };
    }
    if (typeof content !== "string") {
      return { ok: false, error: "invalid parameter: content must be a string" };
    }
    if (typeof label !== "string" || !label.trim()) {
      return { ok: false, error: "invalid parameter: label is required" };
    }
    // 简单扩展名校验（Rust 侧会再次校验）
    const lowerPath = path.toLowerCase();
    if (
      !lowerPath.endsWith(".md") &&
      !lowerPath.endsWith(".markdown") &&
      !lowerPath.endsWith(".mdown") &&
      !lowerPath.endsWith(".mkd")
    ) {
      return { ok: false, error: "path must end with .md, .markdown, .mdown, or .mkd" };
    }
    try {
      const proposalsStore = useProposalsStore();
      const proposalId = `nf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const lineCount = content.split("\n").length;
      proposalsStore.addNewFileProposal({
        id: proposalId,
        path: path.replace(/\\/g, "/"),
        content,
        label,
        lineCount,
        status: "pending",
      });
      return {
        ok: true,
        data: {
          proposalId,
          path: path.replace(/\\/g, "/"),
          lineCount,
          status: "awaiting_user",
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  summarize(result: ToolResult): string {
    if (!result.ok) return result.error ?? t("agent.tools.unknownError");
    const data = result.data as { path?: string; lineCount?: number };
    return t("agent.tools.newFileProposal", { path: data.path ?? "", count: data.lineCount ?? 0 });
  },
};

// ===== 工具注册表 =====
const TOOL_REGISTRY: Record<string, ToolDef> = {
  get_current_document: getCurrentDocument,
  get_selection: getSelection,
  get_visible_range: getVisibleRange,
  get_outline: getOutline,
  list_files: listFiles,
  read_file: readFile,
  search_across_files: searchAcrossFiles,
  propose_insert: proposeInsert,
  propose_replace: proposeReplace,
  propose_new_file: proposeNewFile,
};

/** 获取所有工具元数据（发送给 LLM） */
export function getToolMetadataList(): ToolMetadata[] {
  return Object.values(TOOL_REGISTRY).map((t) => t.metadata);
}

/** 执行工具调用 */
export async function executeTool(
  name: string,
  argsJson: string,
  ctx: ToolContext
): Promise<{ result: ToolResult; summary: string; parsedArgs: unknown }> {
  const tool = TOOL_REGISTRY[name];
  if (!tool) {
    return {
      result: { ok: false, error: `Unknown tool: ${name}` },
      summary: t("agent.tools.unknownTool", { name }),
      parsedArgs: null,
    };
  }

  // arguments 校验：JSON.parse + try/catch
  let parsedArgs: unknown;
  try {
    parsedArgs = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return {
      result: { ok: false, error: "invalid_json" },
      summary: t("agent.tools.invalidJson"),
      parsedArgs: { _error: "invalid_json", raw: argsJson },
    };
  }

  const result = await tool.execute(parsedArgs, ctx);
  const summary = tool.summarize ? tool.summarize(result) : "";
  return { result, summary, parsedArgs };
}
