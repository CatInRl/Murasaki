/**
 * 上下文管理器 — 三层压缩 + 安全护栏 (Ticket #26)
 *
 * 设计参考 spec v0.2.0:
 * - Layer 1 (Q7): 工具结果省略 — 上下文 > 20K 时，旧工具结果仅保留摘要
 * - Layer 2 (Q5): 滑动窗口 + 摘要 — > 40K 普通窗口，> 60K 激进窗口
 * - Guardrail: 16K 单次请求软限制 + 50K 累计 prompt 软限制
 *
 * 压缩顺序: Layer 1 → Layer 2 → 单次请求截断
 * 所有阈值均为软限制：尽量压缩但不阻塞对话
 */

/** LLM 消息格式 */
export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 压缩结果 */
export interface CompressionResult {
  messages: LLMMessage[];
  /** 压缩前估算 token 数 */
  originalTokens: number;
  /** 压缩后估算 token 数 */
  compressedTokens: number;
  /** Layer 1 是否应用 */
  layer1Applied: boolean;
  /** Layer 2 是否应用 */
  layer2Applied: boolean;
  /** 是否触发了单次请求截断 */
  truncated: boolean;
}

// ===== 阈值（token 估算：charCount / 4）=====

/** Layer 1 触发阈值：20K tokens */
const TOOL_OMISSION_THRESHOLD = 20000;

/** Layer 2 普通窗口阈值：40K tokens */
const SLIDING_WINDOW_THRESHOLD = 40000;

/** Layer 2 激进窗口阈值：60K tokens */
const AGGRESSIVE_WINDOW_THRESHOLD = 60000;

/** 单次请求软限制默认值：16384 tokens（超出后截断 oldest，可通过 SettingsState.aiSingleRequestTokenLimit 覆盖） */
const DEFAULT_SINGLE_REQUEST_LIMIT = 16384;

/** 累计 prompt 软限制默认值：51200 tokens（可通过 SettingsState.aiCumulativeTokenSoftLimit 覆盖） */
const DEFAULT_CUMULATIVE_SOFT_LIMIT = 51200;

/** 工具结果触发省略的字符阈值（超过则截断为摘要） */
const TOOL_RESULT_OMIT_CHARS = 800;

/** 工具结果摘要保留的字符数 */
const TOOL_RESULT_SUMMARY_CHARS = 400;

/** Layer 2 普通窗口保留最近消息数 */
const NORMAL_WINDOW_KEEP_RECENT = 10;

/** Layer 2 普通窗口保留最旧消息数 */
const NORMAL_WINDOW_KEEP_FIRST = 2;

/** Layer 2 激进窗口保留最近消息数 */
const AGGRESSIVE_WINDOW_KEEP_RECENT = 6;

/** 滑动窗口摘要中每条消息的预览字符数 */
const SUMMARY_PREVIEW_CHARS = 120;

/** 工具结果消息预览字符数（用于摘要） */
const TOOL_RESULT_PREVIEW_CHARS = 80;

/** 工具结果消息前缀（与 useAgentStore 中一致） */
export const TOOL_RESULT_PREFIX = "工具 ";

/** 摘要标记 */
const SUMMARY_MARKER = "[以下为历史消息摘要，按时间顺序]";

// ===== Token 估算 =====

/** 字符粗估 token 数（ceil(charCount / 4)） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 估算消息列表的总 token 数 */
export function estimateMessagesTokens(messages: LLMMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

// ===== Layer 1: 工具结果省略 =====

/**
 * 将较长的工具结果消息截断为摘要形式
 * 保留工具名称和结果前几百字符，省略完整 JSON
 */
function applyToolResultOmission(messages: LLMMessage[]): LLMMessage[] {
  return messages.map((m) => {
    if (m.role === "user" && m.content.startsWith(TOOL_RESULT_PREFIX)) {
      // 工具结果消息：超过阈值字符（~200 tokens）的截断
      if (m.content.length > TOOL_RESULT_OMIT_CHARS) {
        return {
          ...m,
          content: m.content.slice(0, TOOL_RESULT_SUMMARY_CHARS) + "\n... [工具结果已省略，详见对话记录]",
        };
      }
    }
    return m;
  });
}

// ===== Layer 2: 滑动窗口 + 摘要 =====

/**
 * 滑动窗口压缩：保留 system + 前 N 条 + 摘要 + 最近 M 条
 * @param aggressive 激进模式（保留更少消息）
 */
function applySlidingWindow(messages: LLMMessage[], aggressive: boolean): LLMMessage[] {
  if (messages.length <= 1) return messages;

  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  const keepRecent = aggressive ? AGGRESSIVE_WINDOW_KEEP_RECENT : NORMAL_WINDOW_KEEP_RECENT;
  const keepFirst = aggressive ? 0 : NORMAL_WINDOW_KEEP_FIRST;

  if (nonSystemMessages.length <= keepRecent + keepFirst) return messages;

  const firstMessages = nonSystemMessages.slice(0, keepFirst);
  const recentMessages = nonSystemMessages.slice(-keepRecent);
  const middleMessages = nonSystemMessages.slice(keepFirst, -keepRecent);

  // 生成摘要（不调用 LLM，仅提取角色 + 内容预览）
  const summaryLines = middleMessages.map((m) => {
    const role = m.role === "user" ? "用户" : "助手";
    const isToolResult = m.content.startsWith(TOOL_RESULT_PREFIX);
    const preview = isToolResult
      ? m.content.slice(0, TOOL_RESULT_PREVIEW_CHARS).replace(/\n/g, " ")
      : m.content.slice(0, SUMMARY_PREVIEW_CHARS).replace(/\n/g, " ");
    return `- ${role}: ${preview}...`;
  });
  const summary = `${SUMMARY_MARKER}\n${summaryLines.join("\n")}\n[摘要结束，共 ${middleMessages.length} 条消息]`;

  return [...systemMessages, ...firstMessages, { role: "user", content: summary }, ...recentMessages];
}

// ===== 单次请求截断 =====

/**
 * 硬截断：从最旧的非 system 消息开始移除，直到 token 数 <= limit
 */
function applySingleRequestTruncation(messages: LLMMessage[], limit: number): LLMMessage[] {
  const system = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");

  const systemTokens = estimateMessagesTokens(system);
  let usedTokens = systemTokens;
  const fittingMessages: LLMMessage[] = [];

  // 从最新的消息向前保留，直到达到限制
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(nonSystem[i].content);
    if (usedTokens + msgTokens > limit) break;
    fittingMessages.unshift(nonSystem[i]);
    usedTokens += msgTokens;
  }

  // 如果连 system + 最后一条都超限，只保留 system
  const truncatedCount = nonSystem.length - fittingMessages.length;
  if (truncatedCount > 0) {
    // 添加截断提示
    const truncationNotice: LLMMessage = {
      role: "user",
      content: `[已截断 ${truncatedCount} 条较旧的消息以满足 token 限制]`,
    };
    return [...system, truncationNotice, ...fittingMessages];
  }

  return [...system, ...fittingMessages];
}

// ===== 主压缩函数 =====

/**
 * 三层压缩 + 单次请求截断
 *
 * @param messages 原始 LLM 消息列表
 * @returns 压缩结果
 */
export function compressContext(
  messages: LLMMessage[],
  options?: { singleRequestLimit?: number; cumulativeSoftLimit?: number }
): CompressionResult {
  const singleRequestLimit = options?.singleRequestLimit ?? DEFAULT_SINGLE_REQUEST_LIMIT;
  const originalTokens = estimateMessagesTokens(messages);
  let compressed = [...messages];
  let layer1Applied = false;
  let layer2Applied = false;
  let truncated = false;

  // Layer 1: 工具结果省略（> 20K 时触发）
  if (originalTokens > TOOL_OMISSION_THRESHOLD) {
    compressed = applyToolResultOmission(compressed);
    layer1Applied = true;
  }

  // Layer 2: 滑动窗口 + 摘要
  let currentTokens = estimateMessagesTokens(compressed);
  if (currentTokens > AGGRESSIVE_WINDOW_THRESHOLD) {
    compressed = applySlidingWindow(compressed, true);
    layer2Applied = true;
  } else if (currentTokens > SLIDING_WINDOW_THRESHOLD) {
    compressed = applySlidingWindow(compressed, false);
    layer2Applied = true;
  }

  // 单次请求截断（默认 16384，可由 SettingsState.aiSingleRequestTokenLimit 覆盖）
  currentTokens = estimateMessagesTokens(compressed);
  if (currentTokens > singleRequestLimit) {
    compressed = applySingleRequestTruncation(compressed, singleRequestLimit);
    truncated = true;
  }

  const compressedTokens = estimateMessagesTokens(compressed);

  return {
    messages: compressed,
    originalTokens,
    compressedTokens,
    layer1Applied,
    layer2Applied,
    truncated,
  };
}

// ===== 累计 token 跟踪 =====

/**
 * 累计 prompt token 跟踪器
 *
 * 跟踪整个对话中所有 LLM 请求的 prompt token 总量。
 * 超过 50K 时发出软警告（不阻塞）。
 */
export class CumulativeTokenTracker {
  private _total = 0;

  constructor(
    private readonly _limitGetter: () => number = () => DEFAULT_CUMULATIVE_SOFT_LIMIT
  ) {}

  /** 添加一次请求的 prompt token 数（优先使用 LLM 返回的 usage 精确值） */
  add(tokens: number): void {
    if (tokens > 0) {
      this._total += tokens;
    }
  }

  /** 当前累计 token 数 */
  get total(): number {
    return this._total;
  }

  /** 是否接近限制（80%） */
  get isApproachingLimit(): boolean {
    return this._total > this._limitGetter() * 0.8;
  }

  /** 是否超过限制 */
  get isOverLimit(): boolean {
    return this._total > this._limitGetter();
  }

  /** 限制值（从 SettingsState 读取，随设置变化生效） */
  get limit(): number {
    return this._limitGetter();
  }

  /** 重置（清空对话时调用） */
  reset(): void {
    this._total = 0;
  }
}
