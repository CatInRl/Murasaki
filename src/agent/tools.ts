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
    if (!result.ok) return `✗ ${result.error}`;
    const data = result.data as { content?: string; truncated?: boolean };
    const len = data.content?.length ?? 0;
    return data.truncated ? `已获取 ${len}+ 字符（截断）` : `已获取 ${len} 字符`;
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
    if (!result.ok) return `✗ ${result.error}`;
    if (result.data === null) return "无选区";
    const data = result.data as { text?: string };
    return `已获取 ${data.text?.length ?? 0} 字符选区`;
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
    if (!result.ok) return `✗ ${result.error}`;
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
      const { invoke } = await import("@tauri-apps/api/core");
      const items = await invoke<unknown[]>("parse_outline", { path: docPath });
      return { ok: true, data: items };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  summarize(result: ToolResult): string {
    if (!result.ok) return `✗ ${result.error}`;
    const items = result.data as unknown[];
    return `${items?.length ?? 0} 个标题`;
  },
};

// ===== 工具注册表 =====
const TOOL_REGISTRY: Record<string, ToolDef> = {
  get_current_document: getCurrentDocument,
  get_selection: getSelection,
  get_visible_range: getVisibleRange,
  get_outline: getOutline,
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
      summary: `✗ 未知工具: ${name}`,
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
      summary: "✗ 参数 JSON 解析失败",
      parsedArgs: { _error: "invalid_json", raw: argsJson },
    };
  }

  const result = await tool.execute(parsedArgs, ctx);
  const summary = tool.summarize ? tool.summarize(result) : "";
  return { result, summary, parsedArgs };
}
