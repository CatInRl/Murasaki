/**
 * 通用 OpenAI 兼容 Provider
 *
 * 单一通用类，无子类，无 DSML 过滤器。
 * 通过 baseURL / apiKey / model 配置任意 OpenAI 兼容端点。
 *
 * MVP 固定非思考模式（thinking 参数预留，后续 ticket 启用）。
 */
import OpenAI from "openai";

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
   * 流式聊天补全
   * @param messages 对话历史（含 system / user / assistant）
   * @param callbacks 流式回调
   * @param signal AbortSignal 用于取消
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
          messages,
          stream: true,
        },
        { signal }
      );

      for await (const chunk of stream) {
        // AbortController.abort 会抛 AbortError，跳出循环
        if (signal?.aborted) break;
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          callbacks.onToken(delta);
        }
      }
      callbacks.onDone();
    } catch (err) {
      // AbortError 不作为错误回调（由调用方处理中断逻辑）
      if (err instanceof Error && err.name === "AbortError") {
        callbacks.onDone();
        return;
      }
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
