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

  constructor(config: ProviderConfig) {
    this.client = new OpenAI({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      // 桌面应用，固定前端代码，XSS 隔离在预览面板，生产无 DevTools
      dangerouslyAllowBrowser: true,
    });
    this.model = config.model;
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
   * 流式输出文本 token，同时累积工具调用。
   * 流结束后返回工具调用列表（如果有），由调用方执行后继续循环。
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
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: messages as ChatCompletionMessageParam[],
          tools,
          stream: true,
          // 让最后一个 chunk 携带 usage 字段，用于精确 token 计数
          stream_options: { include_usage: true },
        },
        { signal }
      );

      for await (const chunk of stream) {
        if (signal?.aborted) break;
        // usage 出现在最后一个 chunk（choices 为空数组时）
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
      }

      const toolCalls = Array.from(accumulatedToolCalls.values()).filter((tc) => tc.name);
      callbacks.onDone();

      return {
        hasToolCalls: toolCalls.length > 0,
        toolCalls,
        usage,
      };
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
