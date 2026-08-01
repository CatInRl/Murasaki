/**
 * Provider 接口抽象 — OpenAI + Anthropic 双实现的统一契约
 *
 * ADR-0011: 调用方（useAgentStore）使用 OpenAI 风格消息数组与工具规格，
 * Provider 实现负责在内部做协议翻译。OpenAI 风格作为内部统一契约，
 * Anthropic 做单向翻译（入：OpenAI→Anthropic；出：Anthropic→OpenAI）。
 */
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";
import { AnthropicProvider } from "./AnthropicProvider";

/** Provider 类型标识 */
export type ProviderType = "deepseek" | "openai" | "anthropic" | "custom";

/** Provider 配置（与具体协议无关） */
export interface ProviderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

/**
 * OpenAI 风格的聊天消息 — 调用方与 Provider 之间的统一契约。
 *
 * 沿用 OpenAI Chat Completions 的消息结构：
 * - system 消息放在 messages 数组中（AnthropicProvider 会提取到顶层 system 参数）
 * - assistant 消息可携带 tool_calls（AnthropicProvider 翻译为 tool_use content blocks）
 * - tool 角色消息携带 tool_call_id（AnthropicProvider 翻译为 tool_result content blocks）
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** assistant 消息的工具调用列表（OpenAI 风格） */
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  /** tool 角色消息关联的工具调用 ID */
  tool_call_id?: string;
}

/**
 * OpenAI 风格的工具规格 — {type:"function", function:{name,description,parameters}}
 *
 * AnthropicProvider 会将 parameters 翻译为 input_schema。
 */
export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** 流式回调 */
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
  /** LLM 返回的 token 用量 */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** Provider 接口 — 流式聊天补全的统一抽象 */
export interface Provider {
  /** 流式聊天补全（无工具调用） */
  streamChat(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<void>;

  /** 流式聊天补全 + 工具调用支持 */
  streamChatWithTools(
    messages: ChatMessage[],
    tools: ToolSpec[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<StreamChatWithToolsResult>;
}

/**
 * Provider 工厂函数 — 根据 type 创建对应的 Provider 实现。
 *
 * useAgentStore 只调 createProvider(config)，类型分支集中在此处。
 * 新增协议只需实现 Provider 接口 + 此处加 case。
 */
export function createProvider(config: ProviderConfig & { type: ProviderType }): Provider {
  switch (config.type) {
    case "anthropic":
      return new AnthropicProvider(config);
    case "openai":
    case "deepseek":
    case "custom":
    default:
      return new OpenAICompatibleProvider(config);
  }
}
