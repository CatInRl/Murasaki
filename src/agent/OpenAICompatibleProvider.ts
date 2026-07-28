/**
 * 通用 OpenAI 兼容 Provider
 *
 * 单一通用类，无子类，无 DSML 过滤器。
 * 通过 baseURL / apiKey / model 配置任意 OpenAI 兼容端点。
 *
 * MVP 固定非思考模式（thinking 参数预留，后续 ticket 启用）。
 */
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

export interface ProviderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface StreamCallbacks {
  /** 收到 token 时调用 */
  onToken: (token: string) => void;
  /** 流式结束时调用 */
  onDone: () => void;
  /** 发生错误时调用 */
  onError: (err: Error) => void;
}

/** 流式 + 工具调用的结果 */
export interface StreamChatWithToolsResult {
  /** 是否有工具调用需要执行 */
  hasToolCalls: boolean;
  /** 累积的工具调用列表 */
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  /** LLM 返回的 token 用量（stream_options.include_usage 启用后，最后一个 chunk 携带） */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class OpenAICompatibleProvider {
  private client: OpenAI;
  private model: string;
  private baseURL: string;
  private apiKey: string;

  constructor(config: ProviderConfig) {
    this.baseURL = config.baseURL;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.client = new OpenAI({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      dangerouslyAllowBrowser: true,
    });
  }

  /**
   * 流式聊天补全（无工具调用，Ticket #20 用）
   */
  async streamChat(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    callbacks: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: messages as ChatCompletionMessageParam[],
          stream: true,
        },
        { signal }
      );

      for await (const chunk of stream) {
        if (signal?.aborted) break;
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          callbacks.onToken(delta);
        }
      }
      callbacks.onDone();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        callbacks.onDone();
        return;
      }
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * 流式聊天补全 + 工具调用支持（Ticket #21 用）
   *
   * 使用原生 fetch + ReadableStream 替代 openai npm 的 for await...of，
   * 因为 openai npm 包的 stream iterator 在 Tauri WebView 2 中会 hang。
   */
  async streamChatWithTools(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    tools: ChatCompletionTool[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<StreamChatWithToolsResult> {
    const accumulatedToolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
    let usage: StreamChatWithToolsResult["usage"];

    try {
      const url = this.baseURL.replace(/\/+$/, "") + "/chat/completions";
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: messages as ChatCompletionMessageParam[],
          tools: tools.length > 0 ? tools : undefined,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${errText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("Response body is not readable");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        if (signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        // 解析 SSE 事件行
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // 最后一行可能不完整，保留到下次

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          try {
            const chunk = JSON.parse(data);

            // usage 字段（stream_options 最后一个 chunk）
            if (chunk.usage) {
              usage = {
                prompt_tokens: chunk.usage.prompt_tokens,
                completion_tokens: chunk.usage.completion_tokens,
                total_tokens: chunk.usage.total_tokens,
              };
            }

            const choice = chunk.choices?.[0];
            if (!choice) continue;

            // 流式文本 token
            const delta = choice.delta?.content;
            if (delta) {
              callbacks.onToken(delta);
            }

            // 累积工具调用
            const toolCallDeltas = choice.delta?.tool_calls;
            if (toolCallDeltas) {
              for (const tc of toolCallDeltas) {
                const idx = tc.index ?? 0;
                const existing = accumulatedToolCalls.get(idx) ?? { id: "", name: "", arguments: "" };
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name += tc.function.name;
                if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                accumulatedToolCalls.set(idx, existing);
              }
            }
          } catch {
            // 忽略非 JSON 行
          }
        }
      }

      const toolCalls = Array.from(accumulatedToolCalls.values()).filter((tc) => tc.name);
      callbacks.onDone();
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
}
