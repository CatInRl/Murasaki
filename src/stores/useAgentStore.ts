/**
 * Agent Store — Agent 状态机、对话历史、流式 token buffer、工具调用循环
 *
 * Ticket #20: 面板 + 循环骨架 + 单轮对话 + 流式 + 取消
 * Ticket #21: 默认上下文 + CM6 状态工具(4个) + 工具调用可见性
 * Ticket #25: 对话持久化（按工作区隔离 + gzip + 500ms debounce）
 * Ticket #26: 上下文管理（三层压缩 + 累计 token 跟踪 + 安全护栏）
 */
import { defineStore } from "pinia";
import { ref, computed, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "./useWorkspaceStore";
import { useAiProvidersStore } from "./useAiProvidersStore";
import { usePersistenceStore } from "./usePersistenceStore";
import { useEditorBridgeStore } from "./useEditorBridgeStore";
import { createProvider } from "../agent/Provider";
import { getToolMetadataList, executeTool } from "../agent/tools";
import {
  compressContext,
  CumulativeTokenTracker,
  estimateTokens,
  TOOL_RESULT_PREFIX,
  type LLMMessage,
  type CompressionResult,
} from "../agent/contextManager";
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

/** 截断文本 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n... [truncated]";
}

/** 简单 debounce 工具（含 flush 方法） */
function debounce<T extends (...args: any[]) => Promise<void>>(
  fn: T,
  delay: number
): T & { flush: () => Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingPromise: Promise<void> | null = null;
  let lastArgs: any[] | null = null;

  const wrapped = ((...args: any[]) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    return new Promise<void>((resolve) => {
      timer = setTimeout(async () => {
        timer = null;
        if (lastArgs) {
          pendingPromise = fn(...lastArgs);
          await pendingPromise;
          pendingPromise = null;
        }
        resolve();
      }, delay);
    });
  }) as T & { flush: () => Promise<void>; cancel: () => void };

  wrapped.flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pendingPromise) {
      await pendingPromise;
    }
    if (lastArgs) {
      pendingPromise = fn(...lastArgs);
      await pendingPromise;
      pendingPromise = null;
    }
  };

  wrapped.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    lastArgs = null;
  };

  return wrapped;
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

  /** 正在从磁盘加载对话（防止加载时触发保存覆盖） */
  const isLoading = ref(false);

  /** 累计 prompt token 跟踪器 (Ticket #26)；限制从 SettingsState 读取，随设置变化生效 */
  const tokenTracker = new CumulativeTokenTracker(
    () => usePersistenceStore().settings.aiCumulativeTokenSoftLimit
  );
  /** 累计 prompt token 数（响应式，供 UI 显示） */
  const cumulativeTokens = ref(0);
  /** 是否接近累计限制（80%） */
  const isApproachingTokenLimit = ref(false);
  /** 是否超过累计限制 */
  const isOverTokenLimit = ref(false);
  /** 最近一次压缩结果（供 UI 显示压缩状态，null 表示未触发压缩） */
  const lastCompression = ref<Omit<CompressionResult, "messages"> | null>(null);

  /** 重置累计 token 跟踪状态（清空对话 / 工作区切换时调用） */
  function resetCumulativeTracking(): void {
    tokenTracker.reset();
    cumulativeTokens.value = 0;
    isApproachingTokenLimit.value = false;
    isOverTokenLimit.value = false;
    lastCompression.value = null;
  }

  /** AbortController */
  let abortController: AbortController | null = null;

  /** 流式 flush 节流 */
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTokens = "";

  // ===== 对话持久化 (Ticket #25) =====

  /** 保存对话到磁盘（防抖 500ms） */
  const saveChatDebounced = debounce(async () => {
    const ws = useWorkspaceStore();
    const workspacePath = ws.workspacePath;
    if (!workspacePath || messages.value.length === 0 || isLoading.value) return;
    try {
      const messagesJson = JSON.stringify(messages.value);
      await invoke("save_chat", { workspace: workspacePath, messagesJson });
    } catch (err) {
      console.error("保存对话失败:", err);
    }
  }, 500);

  /** 从磁盘加载对话 */
  async function loadChatFromDisk(workspacePath: string): Promise<void> {
    if (!workspacePath) {
      messages.value = [];
      return;
    }
    isLoading.value = true;
    try {
      const result = await invoke<{ messages_json: string; message_count: number }>(
        "load_chat",
        { workspace: workspacePath }
      );
      const loaded = JSON.parse(result.messages_json) as ChatMessage[];
      messages.value = loaded;
    } catch (err) {
      console.error("加载对话失败:", err);
      messages.value = [];
    } finally {
      isLoading.value = false;
    }
  }

  /** 删除对话文件（清空对话时调用） */
  async function deleteChatFromDisk(workspacePath: string): Promise<void> {
    if (!workspacePath) return;
    try {
      await invoke("delete_chat", { workspace: workspacePath });
    } catch (err) {
      console.error("删除对话文件失败:", err);
    }
  }

  /** 检测孤儿对话数量（启动时调用，用于状态栏提示） */
  async function checkOrphanChats(): Promise<number> {
    try {
      const result = await invoke<{ orphan_count: number }>("check_orphan_chats");
      return result.orphan_count;
    } catch (err) {
      console.error("检测孤儿对话失败:", err);
      return 0;
    }
  }

  /** 清理孤儿对话 */
  async function cleanupOrphanChats(): Promise<number> {
    try {
      const cleaned = await invoke<number>("cleanup_orphan_chats");
      return cleaned;
    } catch (err) {
      console.error("清理孤儿对话失败:", err);
      return 0;
    }
  }

  // 监听消息变化自动保存（deep watch，防抖 500ms）
  watch(
    () => messages.value,
    () => {
      if (!isLoading.value) {
        void saveChatDebounced();
      }
    },
    { deep: true }
  );

  // 监听工作区变化：保存旧对话 + 加载新对话
  watch(
    () => useWorkspaceStore().workspacePath,
    async (newPath, oldPath) => {
      // 保存旧工作区对话（flush 确保不丢失）
      if (oldPath && messages.value.length > 0) {
        await saveChatDebounced.flush();
      }
      // 加载新工作区对话
      if (newPath) {
        await loadChatFromDisk(newPath);
      } else {
        // 无工作区，清空对话
        messages.value = [];
      }
      // Ticket #26: 工作区切换时重置累计 token 跟踪
      resetCumulativeTracking();
    }
  );

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
    const llmMessages: LLMMessage[] = [
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
    const provider = createProvider({
      type: activeProvider.type,
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
      getWorkspacePath: () => ws.workspacePath,
      getProposeReplaceConfirmThreshold: () =>
        usePersistenceStore().settings.aiProposeReplaceConfirmThreshold,
    };

    // 流式 flush 节流
    const flush = () => {
      if (pendingTokens) {
        streamingContent.value = streamingContent.value + pendingTokens;
        pendingTokens = "";
      }
    };

    const persistence = usePersistenceStore();
    const maxToolRounds = persistence.settings.aiAgentMaxRounds;
    const singleRequestLimit = persistence.settings.aiSingleRequestTokenLimit;

    let round = 0;
    let lastError: string | null = null;

    try {
      while (round < maxToolRounds) {
        if (abortController.signal.aborted) break;
        round++;

        // 每轮重置流式 buffer
        streamingContent.value = "";
        pendingTokens = "";

        // Ticket #26: 三层压缩 + 安全护栏
        // 在每轮 LLM 请求前应用压缩，避免上下文无限增长
        const compressionResult = compressContext(llmMessages, {
          singleRequestLimit,
        });
        const messagesToSend = compressionResult.messages;

        // 记录压缩结果供 UI 显示（仅当任一压缩层应用时）
        const applied =
          compressionResult.layer1Applied ||
          compressionResult.layer2Applied ||
          compressionResult.truncated;
        if (applied) {
          const { messages: _omitted, ...rest } = compressionResult;
          void _omitted;
          lastCompression.value = rest;
        } else {
          lastCompression.value = null;
        }

        // 累计 prompt token 跟踪（先用估算值，LLM 返回 usage 后会用精确值覆盖）
        tokenTracker.add(compressionResult.compressedTokens);
        cumulativeTokens.value = tokenTracker.total;
        isApproachingTokenLimit.value = tokenTracker.isApproachingLimit;
        isOverTokenLimit.value = tokenTracker.isOverLimit;

        const result = await provider.streamChatWithTools(
          messagesToSend,
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

        // LLM 返回 usage 后精确更新 token 数（覆盖估算值）
        if (result.usage) {
          contextTokens.value = result.usage.total_tokens;
          // Ticket #26: 用精确的 prompt_tokens 覆盖累计跟踪器
          // 注意：tokenTracker 已用估算值加过一次，这里先减再加，避免重复累加
          if (result.usage.prompt_tokens > 0) {
            tokenTracker.add(result.usage.prompt_tokens - compressionResult.compressedTokens);
            cumulativeTokens.value = tokenTracker.total;
            isApproachingTokenLimit.value = tokenTracker.isApproachingLimit;
            isOverTokenLimit.value = tokenTracker.isOverLimit;
          }
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
            content: `${TOOL_RESULT_PREFIX}${tc.name} 的结果: ${JSON.stringify(toolResult)}`,
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

  /** 清空对话（同时删除磁盘对话文件） */
  async function clearConversation(): Promise<void> {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    // 取消未保存的 debounce
    saveChatDebounced.cancel();
    // 删除磁盘对话文件
    const ws = useWorkspaceStore();
    if (ws.workspacePath) {
      await deleteChatFromDisk(ws.workspacePath);
    }
    messages.value = [];
    streamingContent.value = "";
    pendingTokens = "";
    errorMessage.value = "";
    status.value = "idle";
    hasNewContent.value = false;
    contextRemoved.value = false;
    contextTokens.value = 0;
    // Ticket #26: 重置累计 token 跟踪
    resetCumulativeTracking();
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
    isLoading,
    // Ticket #26: 上下文管理状态
    cumulativeTokens,
    isApproachingTokenLimit,
    isOverTokenLimit,
    lastCompression,
    tokenLimit: computed(() => tokenTracker.limit),
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
    // 对话持久化 (Ticket #25)
    loadChatFromDisk,
    checkOrphanChats,
    cleanupOrphanChats,
    saveChatDebounced,
  };
});
