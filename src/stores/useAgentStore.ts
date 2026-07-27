/**
 * Agent Store — Agent 状态机、对话历史、流式 token buffer、工具调用循环
 *
 * Ticket #20: 面板 + 循环骨架 + 单轮对话 + 流式 + 取消
 * Ticket #21: 默认上下文 + CM6 状态工具(4个) + 工具调用可见性
 */
import { defineStore } from "pinia";
import { ref, computed, shallowRef } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "./useWorkspaceStore";
import { useAiProvidersStore } from "./useAiProvidersStore";
import { useEditorBridgeStore } from "./useEditorBridgeStore";
import { OpenAICompatibleProvider } from "../agent/OpenAICompatibleProvider";
import { getToolMetadataList, executeTool } from "../agent/tools";
import type { ChatMessage, AgentStatus, ToolCallEntry, ContextSnapshot } from "../types";

/** 生成简单唯一 ID */
function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** 系统提示词 */
const SYSTEM_PROMPT =
  "你是 Murasaki 的 AI 助手，帮助用户编辑和管理 Markdown 文档。请简洁清晰地回答。";

/** 8K 字符截断阈值 */
const MAX_CONTENT_CHARS = 8192;

/** 最大工具调用轮数 */
const MAX_TOOL_ROUNDS = 15;

/** 字符粗估 token 数 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 截断文本 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n... [truncated]";
}

export const useAgentStore = defineStore("agent", () => {
  // ===== State =====
  const messages = ref<ChatMessage[]>([]);
  const status = ref<AgentStatus>("idle");
  const streamingContent = shallowRef<string>("");
  const errorMessage = ref<string>("");
  const isAtBottom = ref(true);
  const hasNewContent = ref(false);

  /** 本轮是否移除了当前文档上下文（点 × 按钮） */
  const contextRemoved = ref(false);
  /** 上下文 token 估算 */
  const contextTokens = ref(0);

  /** AbortController */
  let abortController: AbortController | null = null;

  /** 流式 flush 节流 */
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTokens = "";

  // ===== Computed =====
  const canSend = computed(() => {
    const ws = useWorkspaceStore();
    return ws.hasWorkspace && status.value !== "thinking";
  });

  const isThinking = computed(() => status.value === "thinking");

  /** 当前上下文文档路径 */
  const contextDocPath = computed(() => {
    const bridge = useEditorBridgeStore();
    return bridge.activeDocPath;
  });

  /** 是否有上下文 */
  const hasContext = computed(() => {
    return !contextRemoved.value && contextDocPath.value !== null;
  });

  // ===== 上下文构建 =====

  /** 捕获当前文档上下文快照 */
  function captureContextSnapshot(): ContextSnapshot | null {
    const bridge = useEditorBridgeStore();
    const view = bridge.editorView;
    if (!view) return null;

    const docPath = bridge.activeDocPath;
    const sel = view.state.selection.main;
    const cursorPos = sel.from;
    const docText = view.state.doc.toString();
    const line = docText.slice(0, cursorPos).split("\n").length;
    const lineStart = docText.lastIndexOf("\n", cursorPos - 1) + 1;
    const ch = cursorPos - lineStart;

    return {
      docPath,
      cursor: { line, ch },
      selection: sel.empty ? null : { from: sel.from, to: sel.to, text: docText.slice(sel.from, sel.to) },
    };
  }

  /** 构建上下文附加文本（附在 user 消息前） */
  function buildContextText(): string {
    if (contextRemoved.value) return "";
    const bridge = useEditorBridgeStore();
    const view = bridge.editorView;
    if (!view) return "";

    const docPath = bridge.activeDocPath ?? "(未保存)";
    const content = truncate(view.state.doc.toString(), MAX_CONTENT_CHARS);
    const sel = view.state.selection.main;
    const cursorLine = view.state.doc.toString().slice(0, sel.from).split("\n").length;
    const selectionText = sel.empty ? "" : `\n选区: ${view.state.doc.toString().slice(sel.from, sel.to)}`;

    const contextText = `--- 当前文档上下文 ---
路径: ${docPath}
光标: 行 ${cursorLine}
${selectionText}
--- 文档内容 ---
${content}
--- 文档上下文结束 ---`;

    contextTokens.value = estimateTokens(contextText);
    return contextText;
  }

  // ===== Actions =====

  /** 发送消息并启动 agent 循环（含工具调用） */
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

    // 捕获上下文快照
    const snapshot = captureContextSnapshot();

    // 构建带上下文的用户消息
    const contextText = buildContextText();
    const fullText = contextText ? `${contextText}\n\n用户消息: ${text}` : text;

    const userMsg: ChatMessage = {
      id: genId(),
      role: "user",
      content: text, // 显示原文
      createdAt: Date.now(),
      contextSnapshot: snapshot ?? undefined,
    };
    messages.value.push(userMsg);

    // 进入 thinking
    status.value = "thinking";
    errorMessage.value = "";
    streamingContent.value = "";
    pendingTokens = "";

    abortController = new AbortController();

    // 构建 LLM 消息历史
    const llmMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: SYSTEM_PROMPT },
    ];
    // 添加历史（用原文，不重复附带上下文）
    for (const m of messages.value) {
      if (m.role === "system") continue;
      if (m.role === "user") {
        // 第一条 user 消息带上下文，其他用原文
        if (m === userMsg) {
          llmMessages.push({ role: "user", content: fullText });
        } else {
          llmMessages.push({ role: "user", content: m.content });
        }
      } else if (m.role === "assistant") {
        llmMessages.push({ role: "assistant", content: m.content });
      }
    }

    // 创建 provider
    const provider = new OpenAICompatibleProvider({
      baseURL: activeProvider.baseUrl,
      apiKey,
      model: activeProvider.model,
    });

    // 工具元数据
    const tools = getToolMetadataList().map((t) => ({
      type: "function" as const,
      function: t.function,
    }));

    // 工具上下文
    const bridge = useEditorBridgeStore();
    const toolCtx = {
      getEditorView: () => bridge.editorView,
      getDocPath: () => bridge.activeDocPath,
    };

    // 流式 flush 节流
    const flush = () => {
      if (pendingTokens) {
        streamingContent.value = streamingContent.value + pendingTokens;
        pendingTokens = "";
      }
    };

    let round = 0;
    let lastError: string | null = null;

    try {
      while (round < MAX_TOOL_ROUNDS) {
        if (abortController.signal.aborted) break;
        round++;

        // 每轮重置流式 buffer
        streamingContent.value = "";
        pendingTokens = "";

        const result = await provider.streamChatWithTools(
          llmMessages,
          tools,
          {
            onToken: (token: string) => {
              pendingTokens += token;
              if (!isAtBottom.value) hasNewContent.value = true;
              if (!flushTimer) {
                flushTimer = setTimeout(() => {
                  flushTimer = null;
                  flush();
                }, 50);
              }
            },
            onDone: () => {
              if (flushTimer) {
                clearTimeout(flushTimer);
                flushTimer = null;
              }
              flush();
            },
            onError: (err: Error) => {
              if (flushTimer) {
                clearTimeout(flushTimer);
                flushTimer = null;
              }
              flush();
              lastError = err.message;
            },
          },
          abortController.signal
        );

        // LLM 返回 usage 后精确更新 token 数
        if (result.usage) {
          contextTokens.value = result.usage.total_tokens;
        }

        if (abortController.signal.aborted) break;

        if (lastError) {
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
          errorMessage.value = lastError;
          status.value = "error";
          return;
        }

        if (!result.hasToolCalls) {
          // 无工具调用，流式内容即为最终回答
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
          if (status.value === "thinking") status.value = "idle";
          // 恢复上下文（下条消息恢复附带）
          contextRemoved.value = false;
          return;
        }

        // 有工具调用：执行工具
        // 先保存流式文本（如果有）作为 assistant 消息的一部分
        const textBeforeTools = streamingContent.value;
        const toolCallEntries: ToolCallEntry[] = [];

        // 创建 assistant 消息占位（工具调用完成后更新）
        const assistantMsg: ChatMessage = {
          id: genId(),
          role: "assistant",
          content: textBeforeTools,
          toolCalls: toolCallEntries,
          createdAt: Date.now(),
        };
        messages.value.push(assistantMsg);

        // 添加 assistant 消息到 LLM 历史（含 tool_calls）
        llmMessages.push({
          role: "assistant",
          content: textBeforeTools || "(calling tools)",
        });

        // 逐个执行工具
        for (const tc of result.toolCalls) {
          if (abortController.signal.aborted) break;

          const entry: ToolCallEntry = {
            id: tc.id || genId(),
            name: tc.name,
            arguments: tc.arguments,
            status: "calling",
          };
          toolCallEntries.push(entry);

          // 执行工具
          const { result: toolResult, summary, parsedArgs } = await executeTool(
            tc.name,
            tc.arguments,
            toolCtx
          );

          entry.status = toolResult.ok ? "done" : "error";
          entry.summary = summary;
          entry.result = toolResult;
          entry.parsedArgs = parsedArgs;

          // 添加工具结果到 LLM 历史
          llmMessages.push({
            role: "user" as const,
            content: `工具 ${tc.name} 的结果: ${JSON.stringify(toolResult)}`,
          });
        }

        if (abortController.signal.aborted) break;

        // 继续下一轮（LLM 会基于工具结果继续回复）
      }

      // 达到最大轮数
      if (status.value === "thinking") {
        messages.value.push({
          id: genId(),
          role: "assistant",
          content: "(达到最大工具调用轮数限制)",
          createdAt: Date.now(),
        });
        status.value = "idle";
      }
    } catch (err) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      errorMessage.value = err instanceof Error ? err.message : String(err);
      status.value = "error";
    } finally {
      streamingContent.value = "";
      contextRemoved.value = false;
    }
  }

  /** 取消正在进行的请求 */
  function cancel(): void {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingTokens) {
      streamingContent.value = streamingContent.value + pendingTokens;
      pendingTokens = "";
    }
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
    contextRemoved.value = false;
    contextTokens.value = 0;
  }

  /** 移除当前文档上下文（仅本轮） */
  function removeContext(): void {
    contextRemoved.value = true;
  }

  /** 更新滚动位置 */
  function setScrollPosition(atBottom: boolean, _hasNew: boolean = false): void {
    isAtBottom.value = atBottom;
    if (atBottom) {
      hasNewContent.value = false;
    }
  }

  /** 标记新内容已读 */
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
    contextRemoved,
    contextTokens,
    // Computed
    canSend,
    isThinking,
    contextDocPath,
    hasContext,
    // Actions
    sendMessage,
    cancel,
    clearConversation,
    removeContext,
    setScrollPosition,
    markNewContentRead,
  };
});
