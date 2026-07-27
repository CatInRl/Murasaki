/**
 * Agent 工具注册表单元测试 (Ticket #21)
 *
 * 验证 4 个 CM6 状态类工具的元数据、参数校验、执行逻辑、错误处理。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getToolMetadataList, executeTool } from "./tools";
import type { ToolContext } from "./tools";

// Mock Tauri invoke（get_outline 用）
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

function makeCtx(view: unknown, docPath: string | null = "/test.md"): ToolContext {
  return {
    getEditorView: () => view,
    getDocPath: () => docPath,
  };
}

describe("agent tools registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getToolMetadataList", () => {
    it("返回 4 个 CM6 状态类工具", () => {
      const list = getToolMetadataList();
      expect(list).toHaveLength(4);
      const names = list.map((t) => t.function.name);
      expect(names).toContain("get_current_document");
      expect(names).toContain("get_selection");
      expect(names).toContain("get_visible_range");
      expect(names).toContain("get_outline");
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
});
