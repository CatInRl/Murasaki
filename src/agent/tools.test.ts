/**
 * Agent 工具注册表单元测试 (Ticket #21, #22)
 *
 * 验证工具的元数据、参数校验、执行逻辑、错误处理。
 * - Ticket #21: 4 个 CM6 状态类工具
 * - Ticket #22: 3 个文件类工具
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getToolMetadataList, executeTool } from "./tools";
import type { ToolContext } from "./tools";

// Mock Tauri invoke（get_outline / 文件类工具用）
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

/** 构造一个最小可用的 EditorView mock */
function makeEditorView(overrides: Record<string, unknown> = {}) {
  const docText = "# Hello\n\nWorld\n";
  return {
    state: {
      doc: {
        toString: () => docText,
        length: docText.length,
      },
      selection: {
        main: { from: 0, to: 0, empty: true },
      },
    },
    lineBlockAt: (pos: number) => ({ from: pos, to: pos + 10 }),
    scrollDOM: { scrollTop: 0, clientHeight: 100 },
    contentDOM: {} as HTMLElement,
    ...overrides,
  };
}

function makeCtx(
  view: unknown,
  docPath: string | null = "/test.md",
  workspacePath: string | null = "/workspace"
): ToolContext {
  return {
    getEditorView: () => view,
    getDocPath: () => docPath,
    getWorkspacePath: () => workspacePath,
  };
}

describe("agent tools registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getToolMetadataList", () => {
    it("返回 10 个工具（4 CM6 + 3 文件 + 3 提议）", () => {
      const list = getToolMetadataList();
      expect(list).toHaveLength(10);
      const names = list.map((t) => t.function.name);
      // CM6 状态类
      expect(names).toContain("get_current_document");
      expect(names).toContain("get_selection");
      expect(names).toContain("get_visible_range");
      expect(names).toContain("get_outline");
      // 文件类
      expect(names).toContain("list_files");
      expect(names).toContain("read_file");
      expect(names).toContain("search_across_files");
      // 提议类
      expect(names).toContain("propose_insert");
      expect(names).toContain("propose_replace");
      expect(names).toContain("propose_new_file");
    });

    it("所有工具元数据类型为 function", () => {
      const list = getToolMetadataList();
      for (const meta of list) {
        expect(meta.type).toBe("function");
        expect(meta.function.name).toBeTruthy();
        expect(meta.function.description).toBeTruthy();
        expect(meta.function.parameters.type).toBe("object");
      }
    });

    it("工具名使用 snake_case", () => {
      const list = getToolMetadataList();
      for (const meta of list) {
        expect(meta.function.name).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    });
  });

  describe("executeTool - 未知工具", () => {
    it("未知工具名返回错误结果", async () => {
      const ctx = makeCtx(null);
      const { result, summary } = await executeTool("nonexistent", "{}", ctx);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Unknown tool");
      expect(summary).toContain("未知工具");
    });
  });

  describe("executeTool - 参数 JSON 校验", () => {
    it("非法 JSON 参数返回 invalid_json 错误", async () => {
      const ctx = makeCtx(makeEditorView());
      const { result, summary, parsedArgs } = await executeTool(
        "get_current_document",
        "{not valid json",
        ctx
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBe("invalid_json");
      expect(summary).toContain("JSON 解析失败");
      expect(parsedArgs).toMatchObject({ _error: "invalid_json" });
    });

    it("空字符串参数按 {} 处理", async () => {
      const ctx = makeCtx(makeEditorView());
      const { result } = await executeTool("get_current_document", "", ctx);
      expect(result.ok).toBe(true);
    });
  });

  describe("get_current_document", () => {
    it("无 EditorView 时返回错误", async () => {
      const ctx = makeCtx(null);
      const { result, summary } = await executeTool("get_current_document", "{}", ctx);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("No active editor");
      expect(summary).toContain("✗");
    });

    it("返回文档内容、路径、光标、frontmatter", async () => {
      const ctx = makeCtx(makeEditorView(), "/path/test.md");
      const { result, summary } = await executeTool("get_current_document", "{}", ctx);
      expect(result.ok).toBe(true);
      const data = result.data as {
        docPath: string;
        content: string;
        truncated: boolean;
        cursor: { line: number; ch: number };
        selection: unknown;
        frontmatter: unknown;
      };
      expect(data.docPath).toBe("/path/test.md");
      expect(data.content).toContain("Hello");
      expect(data.truncated).toBe(false);
      expect(data.cursor).toEqual({ line: 1, ch: 0 });
      expect(data.selection).toBeNull();
      expect(summary).toContain("已获取");
    });

    it("超长文档被截断并标记 truncated", async () => {
      const longText = "x".repeat(10000);
      const view = makeEditorView({
        state: {
          doc: { toString: () => longText, length: longText.length },
          selection: { main: { from: 0, to: 0, empty: true } },
        },
      });
      const ctx = makeCtx(view);
      const { result, summary } = await executeTool("get_current_document", "{}", ctx);
      expect(result.ok).toBe(true);
      const data = result.data as { truncated: boolean; content: string };
      expect(data.truncated).toBe(true);
      expect(data.content.length).toBeLessThan(longText.length);
      expect(summary).toContain("截断");
    });

    it("提取 frontmatter", async () => {
      const fmText = "---\ntitle: Test\nauthor: Me\n---\n# Hello\n";
      const view = makeEditorView({
        state: {
          doc: { toString: () => fmText, length: fmText.length },
          selection: { main: { from: 0, to: 0, empty: true } },
        },
      });
      const ctx = makeCtx(view);
      const { result } = await executeTool("get_current_document", "{}", ctx);
      expect(result.ok).toBe(true);
      const data = result.data as { frontmatter: Record<string, string> };
      expect(data.frontmatter).toEqual({ title: "Test", author: "Me" });
    });

    it("有选区时返回选区信息", async () => {
      const view = makeEditorView({
        state: {
          doc: { toString: () => "Hello World", length: 11 },
          selection: { main: { from: 0, to: 5, empty: false } },
        },
      });
      const ctx = makeCtx(view);
      const { result } = await executeTool("get_current_document", "{}", ctx);
      const data = result.data as { selection: { from: number; to: number; text: string } };
      expect(data.selection).toEqual({ from: 0, to: 5, text: "Hello" });
    });
  });

  describe("get_selection", () => {
    it("无选区返回 null", async () => {
      const ctx = makeCtx(makeEditorView());
      const { result, summary } = await executeTool("get_selection", "{}", ctx);
      expect(result.ok).toBe(true);
      expect(result.data).toBeNull();
      expect(summary).toBe("无选区");
    });

    it("有选区返回选区文本", async () => {
      const view = makeEditorView({
        state: {
          doc: { toString: () => "Hello World" },
          selection: { main: { from: 6, to: 11, empty: false } },
        },
      });
      const ctx = makeCtx(view);
      const { result, summary } = await executeTool("get_selection", "{}", ctx);
      expect(result.ok).toBe(true);
      const data = result.data as { from: number; to: number; text: string };
      expect(data.text).toBe("World");
      expect(summary).toContain("已获取");
    });

    it("无 EditorView 时返回错误", async () => {
      const ctx = makeCtx(null);
      const { result } = await executeTool("get_selection", "{}", ctx);
      expect(result.ok).toBe(false);
    });
  });

  describe("get_visible_range", () => {
    it("返回行号范围", async () => {
      const ctx = makeCtx(makeEditorView());
      const { result, summary } = await executeTool("get_visible_range", "{}", ctx);
      expect(result.ok).toBe(true);
      const data = result.data as { fromLine: number; toLine: number };
      expect(data.fromLine).toBeGreaterThanOrEqual(1);
      expect(data.toLine).toBeGreaterThanOrEqual(data.fromLine);
      expect(summary).toMatch(/L\d+-\d+/);
    });

    it("无 EditorView 时返回错误", async () => {
      const ctx = makeCtx(null);
      const { result } = await executeTool("get_visible_range", "{}", ctx);
      expect(result.ok).toBe(false);
    });
  });

  describe("get_outline", () => {
    it("无文档路径时返回错误", async () => {
      const ctx = makeCtx(makeEditorView(), null);
      const { result, summary } = await executeTool("get_outline", "{}", ctx);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("No file path");
      expect(summary).toContain("✗");
    });

    it("成功返回大纲", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      (invoke as ReturnType<typeof vi.fn>).mockResolvedValue([
        { level: 1, text: "Hello", line: 1 },
      ]);
      const ctx = makeCtx(makeEditorView(), "/test.md");
      const { result, summary } = await executeTool("get_outline", "{}", ctx);
      expect(result.ok).toBe(true);
      const data = result.data as unknown[];
      expect(data).toHaveLength(1);
      expect(summary).toBe("1 个标题");
    });

    it("invoke 抛错时返回错误结果", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      (invoke as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network"));
      const ctx = makeCtx(makeEditorView(), "/test.md");
      const { result } = await executeTool("get_outline", "{}", ctx);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("network");
    });
  });

  // ===== Ticket #22: 文件类工具 =====
  describe("list_files", () => {
    it("无工作区时返回错误", async () => {
      const ctx = makeCtx(makeEditorView(), "/test.md", null);
      const { result, summary } = await executeTool("list_files", "{}", ctx);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("No workspace open");
      expect(summary).toContain("✗");
    });

    it("成功返回文件列表", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      (invoke as ReturnType<typeof vi.fn>).mockResolvedValue([
        "intro.md",
        "sub/deep.md",
      ]);
      const ctx = makeCtx(makeEditorView(), "/test.md", "/workspace");
      const { result, summary } = await executeTool("list_files", "{}", ctx);
      expect(result.ok).toBe(true);
      const data = result.data as { files: string[] };
      expect(data.files).toEqual(["intro.md", "sub/deep.md"]);
      expect(summary).toBe("2 个文件");
      // 验证 invoke 参数
      expect(invoke).toHaveBeenCalledWith("agent_list_files", {
        workspace: "/workspace",
      });
    });

    it("invoke 抛错时返回错误结果", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      (invoke as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("workspace not exists")
      );
      const ctx = makeCtx(makeEditorView(), "/test.md", "/bad");
      const { result } = await executeTool("list_files", "{}", ctx);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("workspace not exists");
    });
  });

  describe("read_file", () => {
    it("无工作区时返回错误", async () => {
      const ctx = makeCtx(makeEditorView(), "/test.md", null);
      const { result } = await executeTool(
        "read_file",
        JSON.stringify({ path: "intro.md" }),
        ctx
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBe("No workspace open");
    });

    it("缺少 path 参数返回错误", async () => {
      const ctx = makeCtx(makeEditorView(), "/test.md", "/workspace");
      const { result } = await executeTool("read_file", "{}", ctx);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("missing required parameter: path");
    });

    it("path 类型错误返回错误", async () => {
      const ctx = makeCtx(makeEditorView(), "/test.md", "/workspace");
      const { result } = await executeTool(
        "read_file",
        JSON.stringify({ path: 123 }),
        ctx
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("missing required parameter: path");
    });

    it("成功返回文件内容", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      (invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
        docPath: "intro.md",
        content: "# Intro",
        contentHash: "abc123",
        contentLength: 7,
        truncated: false,
      });
      const ctx = makeCtx(makeEditorView(), "/test.md", "/workspace");
      const { result, summary } = await executeTool(
        "read_file",
        JSON.stringify({ path: "intro.md" }),
        ctx
      );
      expect(result.ok).toBe(true);
      const data = result.data as { content: string; truncated: boolean };
      expect(data.content).toBe("# Intro");
      expect(data.truncated).toBe(false);
      expect(summary).toBe("7 字符");
      expect(invoke).toHaveBeenCalledWith("agent_read_file", {
        workspace: "/workspace",
        path: "intro.md",
      });
    });

    it("截断文件标记 truncated", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      (invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
        docPath: "long.md",
        content: "x".repeat(100),
        contentHash: "abc",
        contentLength: 10000,
        truncated: true,
      });
      const ctx = makeCtx(makeEditorView(), "/test.md", "/workspace");
      const { result, summary } = await executeTool(
        "read_file",
        JSON.stringify({ path: "long.md" }),
        ctx
      );
      expect(result.ok).toBe(true);
      expect(summary).toContain("截断");
    });

    it("越界路径由后端拒绝", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      (invoke as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("path outside workspace")
      );
      const ctx = makeCtx(makeEditorView(), "/test.md", "/workspace");
      const { result } = await executeTool(
        "read_file",
        JSON.stringify({ path: "../escape.md" }),
        ctx
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBe("path outside workspace");
    });
  });

  describe("search_across_files", () => {
    it("无工作区时返回错误", async () => {
      const ctx = makeCtx(makeEditorView(), "/test.md", null);
      const { result } = await executeTool(
        "search_across_files",
        JSON.stringify({ query: "hello" }),
        ctx
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBe("No workspace open");
    });

    it("缺少 query 参数返回错误", async () => {
      const ctx = makeCtx(makeEditorView(), "/test.md", "/workspace");
      const { result } = await executeTool("search_across_files", "{}", ctx);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("missing required parameter: query");
    });

    it("空 query 字符串返回空结果（不报错）", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      (invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
        hits: [],
        totalHits: 0,
        truncated: false,
      });
      const ctx = makeCtx(makeEditorView(), "/test.md", "/workspace");
      const { result, summary } = await executeTool(
        "search_across_files",
        JSON.stringify({ query: "" }),
        ctx
      );
      expect(result.ok).toBe(true);
      expect((result.data as { totalHits: number }).totalHits).toBe(0);
      expect(summary).toBe("0 命中");
    });

    it("成功返回搜索结果", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      (invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
        hits: [
          {
            filePath: "intro.md",
            lineNumber: 1,
            lineContent: "# Hello",
            contextBefore: [],
            contextAfter: ["", "World"],
          },
        ],
        totalHits: 1,
        truncated: false,
      });
      const ctx = makeCtx(makeEditorView(), "/test.md", "/workspace");
      const { result, summary } = await executeTool(
        "search_across_files",
        JSON.stringify({ query: "Hello" }),
        ctx
      );
      expect(result.ok).toBe(true);
      const data = result.data as { hits: unknown[]; totalHits: number };
      expect(data.hits).toHaveLength(1);
      expect(data.totalHits).toBe(1);
      expect(summary).toBe("1 命中");
      expect(invoke).toHaveBeenCalledWith("agent_search_files", {
        workspace: "/workspace",
        query: "Hello",
        isRegex: false,
      });
    });

    it("支持 is_regex 参数", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      (invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
        hits: [],
        totalHits: 0,
        truncated: false,
      });
      const ctx = makeCtx(makeEditorView(), "/test.md", "/workspace");
      await executeTool(
        "search_across_files",
        JSON.stringify({ query: "Hello.*World", is_regex: true }),
        ctx
      );
      expect(invoke).toHaveBeenCalledWith("agent_search_files", {
        workspace: "/workspace",
        query: "Hello.*World",
        isRegex: true,
      });
    });

    it("截断结果标记 truncated", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      (invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
        hits: [],
        totalHits: 100,
        truncated: true,
      });
      const ctx = makeCtx(makeEditorView(), "/test.md", "/workspace");
      const { result, summary } = await executeTool(
        "search_across_files",
        JSON.stringify({ query: "a" }),
        ctx
      );
      expect(result.ok).toBe(true);
      expect(summary).toContain("截断");
    });
  });

  // ===== propose_new_file (Ticket #24) =====
  describe("propose_new_file", () => {
    it("无工作区时返回错误", async () => {
      const ctx = makeCtx(makeEditorView(), "/test.md", null);
      const { result, summary } = await executeTool(
        "propose_new_file",
        JSON.stringify({ path: "new.md", content: "# Hi", label: "Create new.md" }),
        ctx
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBe("No workspace open");
      expect(summary).toContain("✗");
    });

    it("缺少 path 参数返回错误", async () => {
      const ctx = makeCtx(makeEditorView(), "/test.md", "/workspace");
      const { result } = await executeTool(
        "propose_new_file",
        JSON.stringify({ content: "# Hi", label: "Create" }),
        ctx
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("path is required");
    });

    it("缺少 content 参数返回错误", async () => {
      const ctx = makeCtx(makeEditorView(), "/test.md", "/workspace");
      const { result } = await executeTool(
        "propose_new_file",
        JSON.stringify({ path: "new.md", label: "Create" }),
        ctx
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("content must be a string");
    });

    it("缺少 label 参数返回错误", async () => {
      const ctx = makeCtx(makeEditorView(), "/test.md", "/workspace");
      const { result } = await executeTool(
        "propose_new_file",
        JSON.stringify({ path: "new.md", content: "# Hi" }),
        ctx
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("label is required");
    });

    it("非 Markdown 扩展名返回错误", async () => {
      const ctx = makeCtx(makeEditorView(), "/test.md", "/workspace");
      const { result } = await executeTool(
        "propose_new_file",
        JSON.stringify({ path: "notes.txt", content: "# Hi", label: "Create" }),
        ctx
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("must end with");
    });

    it("接受 .md/.markdown/.mdown/.mkd 扩展名", async () => {
      // Mock useProposalsStore 避免触发 Pinia 初始化
      const addNewFileProposal = vi.fn();
      vi.doMock("../stores/useProposalsStore", () => ({
        useProposalsStore: () => ({ addNewFileProposal }),
      }));
      const ctx = makeCtx(makeEditorView(), "/test.md", "/workspace");
      for (const ext of ["new.md", "new.markdown", "new.mdown", "new.mkd"]) {
        addNewFileProposal.mockClear();
        const { result } = await executeTool(
          "propose_new_file",
          JSON.stringify({ path: ext, content: "# Hi", label: "Create" }),
          ctx
        );
        expect(result.ok).toBe(true);
        expect(addNewFileProposal).toHaveBeenCalledTimes(1);
      }
      vi.doUnmock("../stores/useProposalsStore");
    });

    it("成功创建提议并调用 store.addNewFileProposal", async () => {
      const addNewFileProposal = vi.fn();
      vi.doMock("../stores/useProposalsStore", () => ({
        useProposalsStore: () => ({ addNewFileProposal }),
      }));
      const ctx = makeCtx(makeEditorView(), "/test.md", "/workspace");
      const { result, summary } = await executeTool(
        "propose_new_file",
        JSON.stringify({
          path: "notes/today.md",
          content: "# Today\n\nSome content",
          label: "创建 today.md",
        }),
        ctx
      );
      expect(result.ok).toBe(true);
      const data = result.data as { proposalId: string; path: string; lineCount: number; status: string };
      expect(data.proposalId).toMatch(/^nf-\w+/);
      expect(data.path).toBe("notes/today.md");
      expect(data.lineCount).toBe(3);
      expect(data.status).toBe("awaiting_user");
      expect(summary).toContain("notes/today.md");
      expect(summary).toContain("3 行");
      expect(addNewFileProposal).toHaveBeenCalledTimes(1);
      const proposalArg = addNewFileProposal.mock.calls[0][0];
      expect(proposalArg.path).toBe("notes/today.md");
      expect(proposalArg.status).toBe("pending");
      expect(proposalArg.label).toBe("创建 today.md");
      vi.doUnmock("../stores/useProposalsStore");
    });

    it("Windows 反斜杠路径转换为正斜杠", async () => {
      const addNewFileProposal = vi.fn();
      vi.doMock("../stores/useProposalsStore", () => ({
        useProposalsStore: () => ({ addNewFileProposal }),
      }));
      const ctx = makeCtx(makeEditorView(), "/test.md", "/workspace");
      const { result } = await executeTool(
        "propose_new_file",
        JSON.stringify({
          path: "sub\\deep\\note.md",
          content: "# Hi",
          label: "Create",
        }),
        ctx
      );
      expect(result.ok).toBe(true);
      const data = result.data as { path: string };
      expect(data.path).toBe("sub/deep/note.md");
      const proposalArg = addNewFileProposal.mock.calls[0][0];
      expect(proposalArg.path).toBe("sub/deep/note.md");
      vi.doUnmock("../stores/useProposalsStore");
    });
  });
});
