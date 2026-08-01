/**
 * AnthropicProvider 单元测试 (ADR-0011, T5.1)
 *
 * 验证：
 * 1. 翻译层：OpenAI 风格 messages → Anthropic 请求体（system / tool_calls / tool 结果）
 * 2. 翻译层：OpenAI ToolSpec[] → Anthropic tools 格式（input_schema）
 * 3. SSE 流解析：text_delta → onToken、tool_use 累积、usage 解析、abort 处理
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AnthropicProvider,
  translateMessages,
  translateTools,
} from "./AnthropicProvider";
import type { ChatMessage, ToolSpec } from "./Provider";

// ===== 翻译层测试 =====

describe("translateMessages", () => {
  it("system 消息提取到顶层 system 字段", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ];
    const result = translateMessages(messages);
    expect(result.system).toBe("You are helpful.");
    expect(result.messages).toEqual([
      { role: "user", content: "Hi" },
    ]);
  });

  it("多条 system 消息用 \\n\\n 连接", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Rule 1." },
      { role: "system", content: "Rule 2." },
      { role: "user", content: "Hi" },
    ];
    const result = translateMessages(messages);
    expect(result.system).toBe("Rule 1.\n\nRule 2.");
    expect(result.messages).toHaveLength(1);
  });

  it("无 system 消息时 system 为 undefined", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Hi" },
    ];
    const result = translateMessages(messages);
    expect(result.system).toBeUndefined();
  });

  it("user 消息保持为字符串 content", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Hello world" },
    ];
    const result = translateMessages(messages);
    expect(result.messages).toEqual([
      { role: "user", content: "Hello world" },
    ]);
  });

  it("assistant 消息无 tool_calls 时保持为字符串 content", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "Hi there" },
    ];
    const result = translateMessages(messages);
    expect(result.messages).toEqual([
      { role: "assistant", content: "Hi there" },
    ]);
  });

  it("assistant 消息含 tool_calls 时翻译为 content blocks（text + tool_use）", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "Let me check.",
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: {
              name: "get_cursor",
              arguments: '{"docPath":"/test.md"}',
            },
          },
        ],
      },
    ];
    const result = translateMessages(messages);
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0];
    expect(msg.role).toBe("assistant");
    expect(Array.isArray(msg.content)).toBe(true);
    const blocks = msg.content as Array<{ type: string; [key: string]: unknown }>;
    // 第一个 block 是 text
    expect(blocks[0]).toEqual({ type: "text", text: "Let me check." });
    // 第二个 block 是 tool_use
    expect(blocks[1]).toEqual({
      type: "tool_use",
      id: "call_abc",
      name: "get_cursor",
      input: { docPath: "/test.md" },
    });
  });

  it("assistant 消息 content 为空时只生成 tool_use block（无 text block）", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "list_files",
              arguments: "{}",
            },
          },
        ],
      },
    ];
    const result = translateMessages(messages);
    const blocks = result.messages[0].content as Array<{ type: string }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("tool_use");
  });

  it("tool 角色消息翻译为 user + tool_result content block", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "list_files", arguments: "{}" },
          },
        ],
      },
      { role: "tool", content: "file1.md\nfile2.md", tool_call_id: "call_1" },
    ];
    const result = translateMessages(messages);
    // tool 消息翻译为 user 角色
    const toolResultMsg = result.messages[1];
    expect(toolResultMsg.role).toBe("user");
    const blocks = toolResultMsg.content as Array<{ type: string; [key: string]: unknown }>;
    expect(blocks[0]).toEqual({
      type: "tool_result",
      tool_use_id: "call_1",
      content: "file1.md\nfile2.md",
    });
  });

  it("混合消息序列完整翻译", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "List files" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "list_files", arguments: "{}" },
          },
        ],
      },
      { role: "tool", content: "file1.md", tool_call_id: "call_1" },
      { role: "assistant", content: "Found 1 file." },
    ];
    const result = translateMessages(messages);
    expect(result.system).toBe("You are helpful.");
    expect(result.messages).toHaveLength(4);
    // user
    expect(result.messages[0]).toEqual({ role: "user", content: "List files" });
    // assistant with tool_use
    expect(result.messages[1].role).toBe("assistant");
    expect(Array.isArray(result.messages[1].content)).toBe(true);
    // tool result (as user)
    expect(result.messages[2].role).toBe("user");
    expect(Array.isArray(result.messages[2].content)).toBe(true);
    // assistant text
    expect(result.messages[3]).toEqual({ role: "assistant", content: "Found 1 file." });
  });

  it("tool_calls arguments 为非法 JSON 时 input 回退为空对象", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "broken", arguments: "{invalid json}" },
          },
        ],
      },
    ];
    const result = translateMessages(messages);
    const blocks = result.messages[0].content as Array<{ type: string; [key: string]: unknown }>;
    expect(blocks[0]).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "broken",
      input: {},
    });
  });
});

describe("translateTools", () => {
  it("OpenAI ToolSpec[] 翻译为 Anthropic tools 格式", () => {
    const tools: ToolSpec[] = [
      {
        type: "function",
        function: {
          name: "get_cursor",
          description: "Get cursor position",
          parameters: {
            type: "object",
            properties: {
              docPath: { type: "string" },
            },
            required: ["docPath"],
          },
        },
      },
    ];
    const result = translateTools(tools);
    expect(result).toEqual([
      {
        name: "get_cursor",
        description: "Get cursor position",
        input_schema: {
          type: "object",
          properties: { docPath: { type: "string" } },
          required: ["docPath"],
        },
      },
    ]);
  });

  it("空 tools 数组返回空数组", () => {
    expect(translateTools([])).toEqual([]);
  });

  it("无 parameters 的工具 input_schema 为 undefined", () => {
    const tools: ToolSpec[] = [
      {
        type: "function",
        function: { name: "no_params", description: "No params" },
      },
    ];
    const result = translateTools(tools);
    expect(result[0].input_schema).toBeUndefined();
  });
});

// ===== SSE 流解析测试 =====

/** 构造 Anthropic SSE 流 */
function makeSSEStream(events: Array<{ event: string; data: unknown }>): ReadableStream<Uint8Array> {
  const text = events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/** mock fetch 返回指定流 */
function mockFetchWithStream(stream: ReadableStream<Uint8Array>, ok = true): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    body: stream,
    text: () => Promise.resolve("error body"),
  }) as unknown as typeof global.fetch;
}

/** 文本流 fixture */
const TEXT_SSE_EVENTS = [
  {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-4-5-20250929",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 25, output_tokens: 1 },
      },
    },
  },
  {
    event: "content_block_start",
    data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  },
  {
    event: "content_block_delta",
    data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
  },
  {
    event: "content_block_delta",
    data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
  },
  {
    event: "content_block_stop",
    data: { type: "content_block_stop", index: 0 },
  },
  {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 15 },
    },
  },
  { event: "message_stop", data: { type: "message_stop" } },
];

/** 工具调用流 fixture */
const TOOL_USE_SSE_EVENTS = [
  {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: "msg_2",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-4-5-20250929",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 30, output_tokens: 1 },
      },
    },
  },
  {
    event: "content_block_start",
    data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  },
  {
    event: "content_block_delta",
    data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check." } },
  },
  {
    event: "content_block_stop",
    data: { type: "content_block_stop", index: 0 },
  },
  {
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_01abc", name: "get_cursor", input: {} },
    },
  },
  {
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"docPath":' },
    },
  },
  {
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '"/test.md"}' },
    },
  },
  {
    event: "content_block_stop",
    data: { type: "content_block_stop", index: 1 },
  },
  {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 50 },
    },
  },
  { event: "message_stop", data: { type: "message_stop" } },
];

describe("AnthropicProvider SSE 流解析", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("text_delta 事件触发 onToken 回调", async () => {
    mockFetchWithStream(makeSSEStream(TEXT_SSE_EVENTS));
    const provider = new AnthropicProvider({
      baseURL: "https://api.anthropic.com",
      apiKey: "test-key",
      model: "claude-sonnet-4-5-20250929",
    });

    const tokens: string[] = [];
    const result = await provider.streamChatWithTools(
      [{ role: "user", content: "Hi" }],
      [],
      {
        onToken: (t) => tokens.push(t),
        onDone: () => {},
        onError: () => {},
      }
    );

    expect(tokens).toEqual(["Hello", " world"]);
    expect(result.hasToolCalls).toBe(false);
    expect(result.toolCalls).toEqual([]);
  });

  it("onDone 在流结束时调用", async () => {
    mockFetchWithStream(makeSSEStream(TEXT_SSE_EVENTS));
    const provider = new AnthropicProvider({
      baseURL: "https://api.anthropic.com",
      apiKey: "test-key",
      model: "claude-sonnet-4-5-20250929",
    });

    let doneCalled = false;
    await provider.streamChatWithTools(
      [{ role: "user", content: "Hi" }],
      [],
      {
        onToken: () => {},
        onDone: () => { doneCalled = true; },
        onError: () => {},
      }
    );

    expect(doneCalled).toBe(true);
  });

  it("tool_use 事件累积为 toolCalls（id/name/arguments）", async () => {
    mockFetchWithStream(makeSSEStream(TOOL_USE_SSE_EVENTS));
    const provider = new AnthropicProvider({
      baseURL: "https://api.anthropic.com",
      apiKey: "test-key",
      model: "claude-sonnet-4-5-20250929",
    });

    const tokens: string[] = [];
    const result = await provider.streamChatWithTools(
      [{ role: "user", content: "Check cursor" }],
      [],
      {
        onToken: (t) => tokens.push(t),
        onDone: () => {},
        onError: () => {},
      }
    );

    // 文本 token 也应正常回调
    expect(tokens).toEqual(["Let me check."]);
    // 工具调用累积
    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls).toEqual([
      {
        id: "toolu_01abc",
        name: "get_cursor",
        arguments: '{"docPath":"/test.md"}',
      },
    ]);
  });

  it("usage 映射：input_tokens→prompt_tokens, output_tokens→completion_tokens", async () => {
    mockFetchWithStream(makeSSEStream(TEXT_SSE_EVENTS));
    const provider = new AnthropicProvider({
      baseURL: "https://api.anthropic.com",
      apiKey: "test-key",
      model: "claude-sonnet-4-5-20250929",
    });

    const result = await provider.streamChatWithTools(
      [{ role: "user", content: "Hi" }],
      [],
      { onToken: () => {}, onDone: () => {}, onError: () => {} }
    );

    expect(result.usage).toEqual({
      prompt_tokens: 25, // from message_start.usage.input_tokens
      completion_tokens: 15, // from message_delta.usage.output_tokens
      total_tokens: 40, // 25 + 15
    });
  });

  it("HTTP 错误时调用 onError", async () => {
    mockFetchWithStream(makeSSEStream([]), false);
    const provider = new AnthropicProvider({
      baseURL: "https://api.anthropic.com",
      apiKey: "test-key",
      model: "claude-sonnet-4-5-20250929",
    });

    let errorCaught: Error | null = null;
    const result = await provider.streamChatWithTools(
      [{ role: "user", content: "Hi" }],
      [],
      {
        onToken: () => {},
        onDone: () => {},
        onError: (err) => { errorCaught = err; },
      }
    );

    expect(errorCaught).not.toBeNull();
    expect(errorCaptured(errorCaught)).toContain("HTTP");
    expect(result.hasToolCalls).toBe(false);
    expect(result.toolCalls).toEqual([]);
  });

  it("abort 信号触发时优雅结束（onDone, 不 onError）", async () => {
    const ctrl = new AbortController();
    // 构造一个挂起的流，在 abort 信号触发时 error 以模拟 fetch abort 行为
    const abortableStream = new ReadableStream({
      start(controller) {
        ctrl.signal.addEventListener("abort", () => {
          const err = new Error("Aborted");
          err.name = "AbortError";
          controller.error(err);
        });
      },
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: abortableStream,
      text: () => Promise.resolve(""),
    }) as unknown as typeof global.fetch;

    const provider = new AnthropicProvider({
      baseURL: "https://api.anthropic.com",
      apiKey: "test-key",
      model: "claude-sonnet-4-5-20250929",
    });

    let doneCalled = false;
    let errorCalled = false;

    // 在请求发起后立即 abort
    setTimeout(() => ctrl.abort(), 10);

    const result = await provider.streamChatWithTools(
      [{ role: "user", content: "Hi" }],
      [],
      {
        onToken: () => {},
        onDone: () => { doneCalled = true; },
        onError: () => { errorCalled = true; },
      },
      ctrl.signal
    );

    expect(doneCalled).toBe(true);
    expect(errorCalled).toBe(false);
    expect(result.hasToolCalls).toBe(false);
    expect(result.toolCalls).toEqual([]);
  });

  it("请求体包含翻译后的 messages 和 system", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string);
      return Promise.resolve({
        ok: true,
        body: makeSSEStream(TEXT_SSE_EVENTS),
        text: () => Promise.resolve(""),
      });
    }) as unknown as typeof global.fetch;

    const provider = new AnthropicProvider({
      baseURL: "https://api.anthropic.com",
      apiKey: "test-key",
      model: "claude-sonnet-4-5-20250929",
    });

    await provider.streamChatWithTools(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hi" },
      ],
      [],
      { onToken: () => {}, onDone: () => {}, onError: () => {} }
    );

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.system).toBe("You are helpful.");
    expect(capturedBody!.messages).toEqual([
      { role: "user", content: "Hi" },
    ]);
    expect(capturedBody!.model).toBe("claude-sonnet-4-5-20250929");
    expect(capturedBody!.stream).toBe(true);
    expect(capturedBody!.max_tokens).toBeDefined();
  });

  it("请求头包含 x-api-key 和 anthropic-version", async () => {
    let capturedHeaders: Record<string, string> | null = null;
    global.fetch = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      capturedHeaders = opts.headers as Record<string, string>;
      return Promise.resolve({
        ok: true,
        body: makeSSEStream(TEXT_SSE_EVENTS),
        text: () => Promise.resolve(""),
      });
    }) as unknown as typeof global.fetch;

    const provider = new AnthropicProvider({
      baseURL: "https://api.anthropic.com",
      apiKey: "my-secret-key",
      model: "claude-sonnet-4-5-20250929",
    });

    await provider.streamChatWithTools(
      [{ role: "user", content: "Hi" }],
      [],
      { onToken: () => {}, onDone: () => {}, onError: () => {} }
    );

    expect(capturedHeaders!["x-api-key"]).toBe("my-secret-key");
    expect(capturedHeaders!["anthropic-version"]).toBe("2023-06-01");
    expect(capturedHeaders!["content-type"]).toBe("application/json");
  });

  it("请求 URL 为 baseURL + /v1/messages", async () => {
    let capturedUrl: string | null = null;
    global.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        body: makeSSEStream(TEXT_SSE_EVENTS),
        text: () => Promise.resolve(""),
      });
    }) as unknown as typeof global.fetch;

    const provider = new AnthropicProvider({
      baseURL: "https://api.anthropic.com",
      apiKey: "key",
      model: "claude-sonnet-4-5-20250929",
    });

    await provider.streamChatWithTools(
      [{ role: "user", content: "Hi" }],
      [],
      { onToken: () => {}, onDone: () => {}, onError: () => {} }
    );

    expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");
  });

  it("baseURL 末尾斜杠被正确处理", async () => {
    let capturedUrl: string | null = null;
    global.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        body: makeSSEStream(TEXT_SSE_EVENTS),
        text: () => Promise.resolve(""),
      });
    }) as unknown as typeof global.fetch;

    const provider = new AnthropicProvider({
      baseURL: "https://api.anthropic.com/",
      apiKey: "key",
      model: "claude-sonnet-4-5-20250929",
    });

    await provider.streamChatWithTools(
      [{ role: "user", content: "Hi" }],
      [],
      { onToken: () => {}, onDone: () => {}, onError: () => {} }
    );

    expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");
  });

  it("tools 非空时请求体包含翻译后的 tools", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string);
      return Promise.resolve({
        ok: true,
        body: makeSSEStream(TEXT_SSE_EVENTS),
        text: () => Promise.resolve(""),
      });
    }) as unknown as typeof global.fetch;

    const provider = new AnthropicProvider({
      baseURL: "https://api.anthropic.com",
      apiKey: "key",
      model: "claude-sonnet-4-5-20250929",
    });

    await provider.streamChatWithTools(
      [{ role: "user", content: "Hi" }],
      [
        {
          type: "function",
          function: {
            name: "get_cursor",
            description: "Get cursor",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      { onToken: () => {}, onDone: () => {}, onError: () => {} }
    );

    expect(capturedBody!.tools).toEqual([
      {
        name: "get_cursor",
        description: "Get cursor",
        input_schema: { type: "object", properties: {} },
      },
    ]);
  });
});

/** 辅助：安全提取 error message */
function errorCaptured(err: Error | null): string {
  return err?.message ?? "";
}
