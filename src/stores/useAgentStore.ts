/**
 * Agent Store — Agent 状态机、对话历史、流式 token buffer
 *
 * Ticket #20: 面板 + 循环骨架 + 单轮对话 + 流式 + 取消 + 无工作区禁用
 * 后续 ticket 扩展：工具调用(#21+)、提议(#23+)、持久化(#25+)、压缩(#26+)
 */
import { defineStore } from "pinia";
import { ref, computed, shallowRef } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "./useWorkspaceStore";
import { useAiProvidersStore } from "./useAiProvidersStore";
import { OpenAICompatibleProvider } from "../agent/OpenAICompatibleProvider";
import type { ChatMessage, AgentStatus } from "../types";

/** 生成简单唯一 ID */
function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** 系统提示词（MVP 简单版本，后续 ticket 完善） */
const SYSTEM_PROMPT = "你是 Murasaki 的 AI 助手，帮助用户编辑和管理 Markdown 文档。请简洁清晰地回答。";

export const useAgentStore = defineStore("agent", () => {
  // ===== State =====
  /** 对话历史 */
  const messages = ref<ChatMessage[]>([]);
  /** Agent 状态机 */
  const status = ref<AgentStatus>("idle");
  /** 流式 token buffer（shallowRef 避免深度响应式开销，手动触发更新） */
  const streamingContent = shallowRef<string>("");
  /** 错误信息 */
  const errorMessage = ref<string>("");
  /** 用户是否在滚动底部（用于自动跟随） */
  const isAtBottom = ref(true);
  /** 是否有新内容未读（用户上滚时收到新消息） */
  const hasNewContent = ref(false);

  /** AbortController（用于取消正在进行的请求） */
  let abortController: AbortController | null = null;

  /** 流式 flush 节流定时器 */
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** 累积的未 flush token */
  let pendingTokens = "";

  // ===== Computed =====
  /** 是否可以发送消息（有工作区 + 非 thinking 状态） */
  const canSend = computed(() => {
    const ws = useWorkspaceStore();
    return ws.hasWorkspace && status.value !== "thinking";
  });

  /** 是否正在思考 */
  const isThinking = computed(() => status.value === "thinking");

  // ===== Actions =====

  /** 发送消息并流式接收回复 */
  async function sendMessage(text: string): Promise<void> {
    const ws = useWorkspaceStore();
    if (!ws.hasWorkspace || status.value === "thinking") return;

    const aiProviders = useAiProvidersStore();
    const activeProvider = aiProviders.activeProvider;
    if (!activeProvider) {
      errorMessage.value = "未配置活动 AI provider";
      return;
    }

    // 获取 API key
    let apiKey: string;
    try {
      apiKey = await invoke<string>("get_api_key", { id: activeProvider.id });
    } catch (err) {
      errorMessage.value = `获取 API key 失败: ${err}`;
      status.value = "error";
      return;
    }

    // 添加用户消息
    const userMsg: ChatMessage = {
      id: genId(),
      role: "user",
      content: text,
      createdAt: Date.now(),
    };
    messages.value.push(userMsg);

    // 进入 thinking 状态
    status.value = "thinking";
    errorMessage.value = "";
    streamingContent.value = "";
    pendingTokens = "";

    // 创建 AbortController
    abortController = new AbortController();

    // 准备对话历史（含 system prompt）
    const chatHistory = [
      { role: "system" as const, content: SYSTEM_PROMPT },
      ...messages.value
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
    ];

    // 创建 provider 并流式请求
    const provider = new OpenAICompatibleProvider({
      baseURL: activeProvider.baseUrl,
      apiKey,
      model: activeProvider.model,
    });

    // 流式 flush 节流（50ms）
    const flush = () => {
      if (pendingTokens) {
        streamingContent.value = streamingContent.value + pendingTokens;
        pendingTokens = "";
      }
    };

    try {
      await provider.streamChat(
        chatHistory,
        {
          onToken: (token: string) => {
            pendingTokens += token;
            if (!isAtBottom.value) hasNewContent.value = true;
            // 50ms 节流 flush
            if (!flushTimer) {
              flushTimer = setTimeout(() => {
                flushTimer = null;
                flush();
              }, 50);
            }
          },
          onDone: () => {
            // 最后 flush 残留 token
            if (flushTimer) {
              clearTimeout(flushTimer);
              flushTimer = null;
            }
            flush();
            // 将流式内容固化为 assistant 消息
            const finalContent = streamingContent.value;
            if (finalContent) {
              messages.value.push({
                id: genId(),
                role: "assistant",
                content: finalContent,
                createdAt: Date.now(),
              });
            }
            streamingContent.value = "";
            // 如果是被中断的，状态已由 cancel() 设置
            if (status.value === "thinking") {
              status.value = "idle";
            }
          },
          onError: (err: Error) => {
            if (flushTimer) {
              clearTimeout(flushTimer);
              flushTimer = null;
            }
            flush();
            // 保留部分回答
            const partial = streamingContent.value;
            if (partial) {
              messages.value.push({
                id: genId(),
                role: "assistant",
                content: partial,
                interrupted: true,
                createdAt: Date.now(),
              });
            }
            streamingContent.value = "";
            errorMessage.value = err.message;
            status.value = "error";
          },
        },
        abortController.signal
      );
    } catch (err) {
      // 网络错误等
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      errorMessage.value = err instanceof Error ? err.message : String(err);
      status.value = "error";
    }
  }

  /** 取消正在进行的请求 */
  function cancel(): void {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    // flush 残留 token
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingTokens) {
      streamingContent.value = streamingContent.value + pendingTokens;
      pendingTokens = "";
    }
    // 保留部分回答 + 中断标签
    const partial = streamingContent.value;
    if (partial) {
      messages.value.push({
        id: genId(),
        role: "assistant",
        content: partial,
        interrupted: true,
        createdAt: Date.now(),
      });
    }
    streamingContent.value = "";
    status.value = "cancelled";
  }

  /** 清空对话 */
  function clearConversation(): void {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    messages.value = [];
    streamingContent.value = "";
    pendingTokens = "";
    errorMessage.value = "";
    status.value = "idle";
    hasNewContent.value = false;
  }

  /** 更新滚动位置 */
  function setScrollPosition(atBottom: boolean, _hasNew: boolean = false): void {
    isAtBottom.value = atBottom;
    if (atBottom) {
      hasNewContent.value = false;
    }
  }

  /** 标记新内容已读（用户点击「↓ 新内容」按钮） */
  function markNewContentRead(): void {
    hasNewContent.value = false;
    isAtBottom.value = true;
  }

  return {
    // State
    messages,
    status,
    streamingContent,
    errorMessage,
    isAtBottom,
    hasNewContent,
    // Computed
    canSend,
    isThinking,
    // Actions
    sendMessage,
    cancel,
    clearConversation,
    setScrollPosition,
    markNewContentRead,
  };
});
