<script setup lang="ts">
/**
 * Agent 面板 — 右侧 380px 固定面板
 *
 * Ticket #20: 面板 + 循环骨架 + 单轮对话 + 流式 + 取消 + 无工作区禁用
 */
import { ref, computed, watch, nextTick, onMounted } from "vue";
import { useAgentStore } from "../stores/useAgentStore";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { useAiProvidersStore } from "../stores/useAiProvidersStore";

const agent = useAgentStore();
const workspace = useWorkspaceStore();
const aiProviders = useAiProvidersStore();

// ===== 输入框 =====
const inputText = ref("");
const inputRef = ref<HTMLTextAreaElement | null>(null);

// ===== 滚动 =====
const conversationRef = ref<HTMLDivElement | null>(null);

/** 滀动到底部 */
function scrollToBottom(): void {
  if (conversationRef.value) {
    conversationRef.value.scrollTop = conversationRef.value.scrollHeight;
  }
}

/** 检查是否在底部 */
function checkScroll(): void {
  const el = conversationRef.value;
  if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  agent.setScrollPosition(atBottom);
}

/** 点击「↓ 新内容」按钮 */
function onClickNewContent(): void {
  agent.markNewContentRead();
  nextTick(() => scrollToBottom());
}

// 流式内容变化时，如果在底部则跟随滚动
watch(
  () => agent.streamingContent,
  () => {
    if (agent.isAtBottom) {
      nextTick(() => scrollToBottom());
    }
  }
);

// 新消息时，如果在底部则跟随滚动
watch(
  () => agent.messages.length,
  () => {
    if (agent.isAtBottom) {
      nextTick(() => scrollToBottom());
    }
  }
);

// ===== 发送 / 停止 =====
async function onSend(): Promise<void> {
  const text = inputText.value.trim();
  if (!text || !agent.canSend) return;
  inputText.value = "";
  // 发送后滚到底部
  agent.setScrollPosition(true);
  await agent.sendMessage(text);
  nextTick(() => scrollToBottom());
}

function onStop(): void {
  agent.cancel();
}

/** Ctrl+Enter 发送 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    onSend();
  }
}

// ===== 面板收起 =====
const emit = defineEmits<{
  (e: "collapse"): void;
  (e: "open-folder-dialog"): void;
  (e: "open-settings"): void;
}>();

function onCollapse(): void {
  emit("collapse");
}

// ===== 空状态判断 =====
const showNoWorkspace = computed(() => !workspace.hasWorkspace);
const showNoProvider = computed(
  () => workspace.hasWorkspace && !aiProviders.hasProvider
);

function onOpenWorkspace(): void {
  emit("open-folder-dialog");
}

function onOpenSettings(): void {
  emit("open-settings");
}

// ===== 加载 AI providers =====
onMounted(() => {
  if (!aiProviders.loaded) {
    aiProviders.load();
  }
});
</script>

<template>
  <div class="agent-panel">
    <!-- Header -->
    <div class="agent-header">
      <div class="agent-header-left">
        <svg class="agent-header-icon" viewBox="0 0 24 24" width="15" height="15">
          <path
            fill="currentColor"
            d="M12 2L9.5 8.5L3 11l6.5 2.5L12 20l2.5-6.5L21 11l-6.5-2.5L12 2z"
          />
        </svg>
        <span class="agent-header-title">Agent</span>
      </div>
      <button class="agent-collapse-btn" title="收起面板" @click="onCollapse">
        <svg viewBox="0 0 24 24" width="14" height="14">
          <path
            fill="currentColor"
            d="M9.29 6.71a1 1 0 000 1.41L13.17 12l-3.88 3.88a1 1 0 101.41 1.41l4.59-4.59a1 1 0 000-1.41L10.7 6.7a1 1 0 00-1.41.01z"
          />
        </svg>
      </button>
    </div>

    <!-- 空状态：无工作区 -->
    <div v-if="showNoWorkspace" class="agent-empty-state">
      <svg viewBox="0 0 24 24" width="40" height="40" class="empty-icon">
        <path
          fill="currentColor"
          d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"
        />
      </svg>
      <p class="empty-title">打开工作区后启用 Agent</p>
      <p class="empty-desc">Agent 需要工作区上下文才能辅助编辑</p>
      <button class="empty-action" @click="onOpenWorkspace">打开工作区</button>
    </div>

    <!-- 空状态：未配置 provider -->
    <div v-else-if="showNoProvider" class="agent-empty-state">
      <svg viewBox="0 0 24 24" width="40" height="40" class="empty-icon">
        <path
          fill="currentColor"
          d="M12 2L9.5 8.5L3 11l6.5 2.5L12 20l2.5-6.5L21 11l-6.5-2.5L12 2z"
          opacity="0.4"
        />
      </svg>
      <p class="empty-title">未配置 AI 服务</p>
      <p class="empty-desc">请在设置中配置 AI Provider</p>
      <button class="empty-action" @click="onOpenSettings">打开设置</button>
    </div>

    <!-- 正常状态：对话区 + 输入区 -->
    <template v-else>
      <!-- 对话区 -->
      <div
        ref="conversationRef"
        class="agent-conversation"
        @scroll="checkScroll"
      >
        <!-- 空对话提示 -->
        <div v-if="agent.messages.length === 0" class="agent-welcome">
          <p>向 Agent 发送消息开始对话</p>
        </div>

        <!-- 消息列表 -->
        <div
          v-for="msg in agent.messages"
          :key="msg.id"
          class="agent-message"
          :class="{
            'agent-message-user': msg.role === 'user',
            'agent-message-assistant': msg.role === 'assistant',
          }"
        >
          <!-- assistant 头像 -->
          <div v-if="msg.role === 'assistant'" class="agent-avatar">
            <svg viewBox="0 0 24 24" width="13" height="13">
              <path
                fill="currentColor"
                d="M12 2L9.5 8.5L3 11l6.5 2.5L12 20l2.5-6.5L21 11l-6.5-2.5L12 2z"
              />
            </svg>
          </div>
          <!-- 气泡 -->
          <div
            class="agent-message-bubble"
            :class="{
              'agent-message-bubble-user': msg.role === 'user',
              'agent-message-bubble-assistant': msg.role === 'assistant',
            }"
          >
            {{ msg.content }}
            <span v-if="msg.interrupted" class="agent-interrupted-tag">
              ⚠ 已中断
            </span>
          </div>
        </div>

        <!-- 流式中的消息 -->
        <div
          v-if="agent.isThinking && agent.streamingContent"
          class="agent-message agent-message-assistant"
        >
          <div class="agent-avatar">
            <svg viewBox="0 0 24 24" width="13" height="13">
              <path
                fill="currentColor"
                d="M12 2L9.5 8.5L3 11l6.5 2.5L12 20l2.5-6.5L21 11l-6.5-2.5L12 2z"
              />
            </svg>
          </div>
          <div class="agent-message-bubble agent-message-bubble-assistant">
            {{ agent.streamingContent }}<span class="streaming-cursor"></span>
          </div>
        </div>

        <!-- thinking 但无内容时显示等待指示器 -->
        <div
          v-if="agent.isThinking && !agent.streamingContent"
          class="agent-message agent-message-assistant"
        >
          <div class="agent-avatar">
            <svg viewBox="0 0 24 24" width="13" height="13">
              <path
                fill="currentColor"
                d="M12 2L9.5 8.5L3 11l6.5 2.5L12 20l2.5-6.5L21 11l-6.5-2.5L12 2z"
              />
            </svg>
          </div>
          <div class="agent-message-bubble agent-message-bubble-assistant">
            <span class="agent-thinking-dots">思考中...</span>
          </div>
        </div>

        <!-- 错误信息 -->
        <div v-if="agent.errorMessage" class="agent-error">
          {{ agent.errorMessage }}
        </div>
      </div>

      <!-- ↓ 新内容按钮 -->
      <div
        v-if="agent.hasNewContent"
        class="agent-new-content-btn"
        @click="onClickNewContent"
      >
        ↓ 新内容
      </div>

      <!-- 输入区 -->
      <div class="agent-input-area">
        <div class="agent-input-wrapper">
          <textarea
            ref="inputRef"
            v-model="inputText"
            class="agent-input"
            placeholder="向 Agent 发送消息..."
            :disabled="agent.isThinking"
            rows="3"
            @keydown="onKeydown"
          ></textarea>
        </div>
        <button
          v-if="!agent.isThinking"
          class="agent-send-btn agent-send-btn-send"
          :disabled="!inputText.trim()"
          @click="onSend"
        >
          <svg viewBox="0 0 24 24" width="16" height="16">
            <path
              fill="currentColor"
              d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"
            />
          </svg>
        </button>
        <button
          v-else
          class="agent-send-btn agent-send-btn-stop"
          @click="onStop"
          title="停止"
        >
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path fill="currentColor" d="M6 6h12v12H6z" />
          </svg>
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.agent-panel {
  width: 380px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--murasaki-surface, #ffffff);
  border-left: 1px solid var(--murasaki-line, #e5e7eb);
  overflow: hidden;
}

/* Header */
.agent-header {
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  background: var(--murasaki-background, #fafafa);
  border-bottom: 1px solid var(--murasaki-line, #e5e7eb);
}
.agent-header-left {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--murasaki-primary, #9333ea);
}
.agent-header-title {
  font-size: 13px;
  font-weight: 600;
}
.agent-collapse-btn {
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--murasaki-muted, #6b7280);
}
.agent-collapse-btn:hover {
  background: var(--murasaki-hover, #f3f4f6);
}

/* 空状态 */
.agent-empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
  text-align: center;
  gap: 8px;
}
.empty-icon {
  color: var(--murasaki-muted, #9ca3af);
  margin-bottom: 8px;
}
.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--murasaki-ink, #1f2937);
  margin: 0;
}
.empty-desc {
  font-size: 12px;
  color: var(--murasaki-muted, #6b7280);
  margin: 0 0 12px;
}
.empty-action {
  padding: 6px 16px;
  border: 1px solid var(--murasaki-primary, #9333ea);
  background: transparent;
  color: var(--murasaki-primary, #9333ea);
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
}
.empty-action:hover {
  background: var(--murasaki-purple-50, rgba(147, 51, 234, 0.06));
}

/* 对话区 */
.agent-conversation {
  flex: 1;
  overflow-y: auto;
  padding: 8px 10px 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.agent-conversation::-webkit-scrollbar {
  width: 5px;
}
.agent-conversation::-webkit-scrollbar-thumb {
  background: var(--murasaki-line, #d1d5db);
  border-radius: 3px;
}

/* 空对话欢迎 */
.agent-welcome {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--murasaki-muted, #9ca3af);
  font-size: 12px;
}

/* 消息 */
.agent-message {
  display: flex;
  flex-direction: column;
}
.agent-message-user {
  align-items: flex-end;
}
.agent-message-assistant {
  align-items: flex-start;
  flex-direction: row;
  gap: 6px;
}

/* 头像 */
.agent-avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--murasaki-purple-100, rgba(147, 51, 234, 0.12));
  color: var(--murasaki-primary, #9333ea);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 2px;
}

/* 气泡 */
.agent-message-bubble {
  max-width: calc(100% - 28px);
  padding: 8px 12px;
  font-size: 13px;
  line-height: 1.55;
  border-radius: 8px;
  word-break: break-word;
  white-space: pre-wrap;
}
.agent-message-bubble-user {
  background: var(--murasaki-purple-100, rgba(147, 51, 234, 0.12));
  color: var(--murasaki-purple-900, #581c87);
  border-bottom-right-radius: 4px;
}
.agent-message-bubble-assistant {
  background: var(--murasaki-background, #fafafa);
  color: var(--murasaki-ink, #1f2937);
  border: 1px solid var(--murasaki-line, #e5e7eb);
  border-bottom-left-radius: 4px;
}

/* 中断标签 */
.agent-interrupted-tag {
  display: inline-block;
  margin-left: 4px;
  color: var(--murasaki-muted, #9ca3af);
  font-size: 11px;
  font-style: italic;
}

/* 流式光标 */
.streaming-cursor {
  display: inline-block;
  width: 7px;
  height: 15px;
  background: var(--murasaki-primary, #9333ea);
  border-radius: 1px;
  margin-left: 2px;
  vertical-align: text-bottom;
  animation: blink-cursor 0.8s ease-in-out infinite;
}
@keyframes blink-cursor {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0;
  }
}

/* 思考中 */
.agent-thinking-dots {
  color: var(--murasaki-muted, #9ca3af);
  font-style: italic;
}

/* 错误 */
.agent-error {
  font-size: 12px;
  color: var(--murasaki-state-error, #dc2626);
  padding: 6px 10px;
  background: rgba(220, 38, 38, 0.06);
  border-radius: 4px;
}

/* 新内容按钮 */
.agent-new-content-btn {
  position: absolute;
  bottom: 100px;
  right: 10px;
  padding: 4px 10px;
  background: var(--murasaki-primary, #9333ea);
  color: #fff;
  border-radius: 12px;
  font-size: 11px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  z-index: 10;
}

/* 输入区 */
.agent-input-area {
  padding: 8px 10px 10px;
  border-top: 1px solid var(--murasaki-line, #e5e7eb);
  background: var(--murasaki-background, #fafafa);
  display: flex;
  gap: 6px;
  align-items: flex-end;
}
.agent-input-wrapper {
  flex: 1;
  border: 1px solid var(--murasaki-line, #d1d5db);
  border-radius: 6px;
  background: #fff;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.agent-input-wrapper:focus-within {
  border-color: var(--murasaki-ring, #9333ea);
  box-shadow: 0 0 0 2px rgba(147, 51, 234, 0.1);
}
.agent-input {
  width: 100%;
  border: none;
  outline: none;
  resize: none;
  padding: 6px 8px;
  font-size: 13px;
  line-height: 1.5;
  font-family: inherit;
  background: transparent;
  color: var(--murasaki-ink, #1f2937);
}
.agent-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 发送 / 停止按钮 */
.agent-send-btn {
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: #fff;
  transition: background 0.15s;
}
.agent-send-btn-send {
  background: var(--murasaki-primary, #9333ea);
}
.agent-send-btn-send:hover {
  background: var(--murasaki-purple-700, #7e22ce);
}
.agent-send-btn-send:disabled {
  background: var(--murasaki-line, #d1d5db);
  cursor: not-allowed;
}
.agent-send-btn-stop {
  background: var(--murasaki-state-error, #dc2626);
}
.agent-send-btn-stop:hover {
  background: #b91c1c;
}
</style>
