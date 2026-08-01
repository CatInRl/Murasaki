/**
 * AnthropicProvider — Anthropic Messages API 的 Provider 实现
 *
 * ADR-0011: 实现 Provider 接口，内部做三件翻译：
 * 1. 请求体翻译：OpenAI 风格 messages → Anthropic 格式
 * 2. 流式响应翻译：Anthropic SSE 事件 → onToken / toolCalls / usage
 * 3. 工具调用结果归一化：输出 StreamChatWithToolsResult.toolCalls 与 OpenAI 实现一致
 *
 * 使用原生 fetch + ReadableStream 解析 SSE（与 OpenAICompatibleProvider 一致，
 * 避免 openai npm 在 WebView2 的 hang 问题）。
 */
import type {
  Provider,
  ProviderConfig,
  ChatMessage,
  ToolSpec,
  StreamCallbacks,
  StreamChatWithToolsResult,
} from "./Provider";

// ===== Anthropic 内部类型 =====

interface AnthropicContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

// ===== 翻译层（导出供单元测试） =====

/**
 * OpenAI 风格 messages → Anthropic 请求体
 *
 * - system 消息提取到顶层 system 字段（多条用 \n\n 连接）
 * - assistant + tool_calls → content blocks（text? + tool_use[]）
 * - tool 角色消息 → user + tool_result content block
 * - 普通 user/assistant → 保持字符串 content
 */
export function translateMessages(
  messages: ChatMessage[]
): { system: string | undefined; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const anthropicMessages: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
      continue;
    }

    if (msg.role === "tool") {
      anthropicMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id ?? "",
            content: msg.content,
          },
        ],
      });
      continue;
    }

    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      const blocks: AnthropicContentBlock[] = [];
      if (msg.content) {
        blocks.push({ type: "text", text: msg.content });
      }
      for (const tc of msg.tool_calls) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          input = {};
        }
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
      anthropicMessages.push({ role: "assistant", content: blocks });
      continue;
    }

    // 普通 user/assistant 消息
    anthropicMessages.push({
      role: msg.role as "user" | "assistant",
      content: msg.content,
    });
  }

  const system = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
  return { system, messages: anthropicMessages };
}

/**
 * OpenAI ToolSpec[] → Anthropic tools 格式
 *
 * {type:"function", function:{name,description,parameters}}
 * → {name, description, input_schema: parameters}
 */
export function translateTools(tools: ToolSpec[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

// ===== SSE 解析上下文 =====

interface SSEContext {
  trackToolUse: boolean;
  toolUseBlocks: Map<number, { id: string; name: string; arguments: string }>;
  promptTokens: number;
  completionTokens: number;
}

// ===== AnthropicProvider =====

const ANTHROPIC_API_VERSION = "2023-06-01";
const MAX_TOKENS = 8192;

export class AnthropicProvider implements Provider {
  private baseURL: string;
  private apiKey: string;
  private model: string;

  constructor(config: ProviderConfig) {
    this.baseURL = config.baseURL;
    this.apiKey = config.apiKey;
    this.model = config.model;
  }

  async streamChat(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      const { system, messages: anthropicMessages } = translateMessages(messages);
      const url = this.baseURL.replace(/\/+$/, "") + "/v1/messages";
      const response = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          model: this.model,
          max_tokens: MAX_TOKENS,
          ...(system ? { system } : {}),
          messages: anthropicMessages,
          stream: true,
        }),
        signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${errText}`);
      }

      const ctx: SSEContext = {
        trackToolUse: false,
        toolUseBlocks: new Map(),
        promptTokens: 0,
        completionTokens: 0,
      };
      await this.parseSSEStream(response, callbacks, signal, ctx);
      callbacks.onDone();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        callbacks.onDone();
        return;
      }
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async streamChatWithTools(
    messages: ChatMessage[],
    tools: ToolSpec[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<StreamChatWithToolsResult> {
    const ctx: SSEContext = {
      trackToolUse: true,
      toolUseBlocks: new Map(),
      promptTokens: 0,
      completionTokens: 0,
    };

    try {
      const { system, messages: anthropicMessages } = translateMessages(messages);
      const anthropicTools = translateTools(tools);
      const url = this.baseURL.replace(/\/+$/, "") + "/v1/messages";

      const response = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          model: this.model,
          max_tokens: MAX_TOKENS,
          ...(system ? { system } : {}),
          messages: anthropicMessages,
          ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
          stream: true,
        }),
        signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${errText}`);
      }

      await this.parseSSEStream(response, callbacks, signal, ctx);

      const toolCalls = Array.from(ctx.toolUseBlocks.values()).filter((tc) => tc.name);
      callbacks.onDone();

      const usage: StreamChatWithToolsResult["usage"] | undefined =
        ctx.promptTokens > 0 || ctx.completionTokens > 0
          ? {
              prompt_tokens: ctx.promptTokens,
              completion_tokens: ctx.completionTokens,
              total_tokens: ctx.promptTokens + ctx.completionTokens,
            }
          : undefined;

      return { hasToolCalls: toolCalls.length > 0, toolCalls, usage };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        callbacks.onDone();
        return { hasToolCalls: false, toolCalls: [] };
      }
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      return { hasToolCalls: false, toolCalls: [] };
    }
  }

  private buildHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
    };
  }

  private async parseSSEStream(
    response: Response,
    callbacks: StreamCallbacks,
    signal: AbortSignal | undefined,
    ctx: SSEContext
  ): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Response body is not readable");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const event = JSON.parse(data);
          this.handleSSEEvent(event, callbacks, ctx);
        } catch {
          // 忽略非 JSON 行
        }
      }
    }
  }

  private handleSSEEvent(
    event: { type: string; [key: string]: unknown },
    callbacks: StreamCallbacks,
    ctx: SSEContext
  ): void {
    switch (event.type) {
      case "message_start": {
        const message = event.message as
          | { usage?: { input_tokens?: number } }
          | undefined;
        if (message?.usage?.input_tokens != null) {
          ctx.promptTokens = message.usage.input_tokens;
        }
        break;
      }
      case "content_block_start": {
        if (!ctx.trackToolUse) break;
        const index = event.index as number;
        const block = event.content_block as
          | { type: string; id?: string; name?: string }
          | undefined;
        if (block?.type === "tool_use" && block.id && block.name) {
          ctx.toolUseBlocks.set(index, {
            id: block.id,
            name: block.name,
            arguments: "",
          });
        }
        break;
      }
      case "content_block_delta": {
        const delta = event.delta as
          | { type: string; text?: string; partial_json?: string }
          | undefined;
        if (!delta) break;
        if (delta.type === "text_delta" && delta.text) {
          callbacks.onToken(delta.text);
        } else if (
          delta.type === "input_json_delta" &&
          delta.partial_json != null &&
          ctx.trackToolUse
        ) {
          const index = event.index as number;
          const existing = ctx.toolUseBlocks.get(index);
          if (existing) {
            existing.arguments += delta.partial_json;
          }
        }
        break;
      }
      case "message_delta": {
        const usage = event.usage as { output_tokens?: number } | undefined;
        if (usage?.output_tokens != null) {
          ctx.completionTokens = usage.output_tokens;
        }
        break;
      }
      case "message_stop":
        break;
    }
  }
}
