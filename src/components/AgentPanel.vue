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
import { useProposalsStore } from "../stores/useProposalsStore";

const agent = useAgentStore();
const workspace = useWorkspaceStore();
const aiProviders = useAiProvidersStore();
const proposals = useProposalsStore();

// ===== 输入框 =====
const inputText = ref("");
const inputRef = ref<HTMLTextAreaElement | null>(null);

// ===== 工具调用展开状态 =====
const expandedToolCalls = ref<Set<string>>(new Set());

function toggleToolCall(id: string): void {
  if (expandedToolCalls.value.has(id)) {
    expandedToolCalls.value.delete(id);
  } else {
    expandedToolCalls.value.add(id);
  }
}

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

    <!-- 上下文卡片（显示当前文档 + token 数 + × 移除） -->
    <div
      v-if="agent.hasContext && agent.contextDocPath"
      class="agent-context-card"
    >
      <svg class="agent-context-icon" viewBox="0 0 24 24" width="12" height="12">
        <path
          fill="currentColor"
          d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z"
        />
      </svg>
      <span class="agent-context-path">{{ agent.contextDocPath }}</span>
      <span class="agent-context-tokens">≈ {{ agent.contextTokens }} tokens</span>
      <button class="agent-context-remove" title="移除当前文档上下文" @click="agent.removeContext()">
        ×
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

          <!-- 工具调用条目（assistant 消息下） -->
          <div
            v-if="msg.toolCalls && msg.toolCalls.length > 0"
            class="agent-tool-calls"
          >
            <div
              v-for="tc in msg.toolCalls"
              :key="tc.id"
              class="tool-call-entry"
              :class="{
                'tool-call-calling': tc.status === 'calling',
                'tool-call-done': tc.status === 'done',
                'tool-call-error': tc.status === 'error',
              }"
              @click="toggleToolCall(tc.id)"
            >
              <div class="tool-call-header">
                <span class="tool-call-icon">🔧</span>
                <span class="tool-call-name">{{ tc.name }}</span>
                <span class="tool-call-summary">
                  {{ tc.status === "calling" ? "调用中..." : tc.summary }}
                </span>
              </div>
              <div v-if="expandedToolCalls.has(tc.id)" class="tool-call-detail">
                <div class="tool-call-section">
                  <span class="tool-call-label">参数:</span>
                  <pre class="tool-call-pre">{{ JSON.stringify(tc.parsedArgs, null, 2) }}</pre>
                </div>
                <div v-if="tc.result" class="tool-call-section">
                  <span class="tool-call-label">结果:</span>
                  <pre class="tool-call-pre">{{ JSON.stringify(tc.result, null, 2).slice(0, 500) }}</pre>
                </div>
              </div>
            </div>
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

      <!-- 提议列表 (Ticket #23) -->
      <div
        v-if="proposals.hasProposals"
        class="agent-proposal-list"
      >
        <div class="proposal-list-header">
          <svg class="proposal-list-icon" viewBox="0 0 24 24" width="12" height="12">
            <path fill="currentColor" d="M12 2L9.91 8.84 3 9.27l5.46 4.73L6.82 21 12 17.27 17.18 21l-1.64-6.99L21 9.27l-6.91-.43L12 2z"/>
          </svg>
          <span class="proposal-list-title">提议 ({{ proposals.pendingProposals.length }})</span>
        </div>
        <div
          v-for="p in proposals.proposals"
          :key="p.id"
          class="proposal-item"
          :class="{
            'proposal-pending': p.status === 'pending',
            'proposal-accepted': p.status === 'accepted',
            'proposal-rejected': p.status === 'rejected',
            'proposal-expired': p.status === 'expired',
            'proposal-flash': proposals.flashingId === p.id,
          }"
          @click="p.status === 'pending' && proposals.jumpToProposal(p.id)"
        >
          <span class="proposal-item-icon">{{ p.type === 'insert' ? '＋' : '↻' }}</span>
          <span class="proposal-item-label">{{ p.label }}</span>
          <span class="proposal-item-meta">{{ p.lineCount }} 行</span>
          <template v-if="p.status === 'pending'">
            <button
              class="proposal-item-btn proposal-item-accept"
              title="接受"
              @click.stop="proposals.acceptProposal(p.id)"
            >✓</button>
            <button
              class="proposal-item-btn proposal-item-reject"
              title="拒绝"
              @click.stop="proposals.rejectProposal(p.id)"
            >✗</button>
          </template>
          <span v-else-if="p.status === 'accepted'" class="proposal-item-status">已接受</span>
          <span v-else-if="p.status === 'rejected'" class="proposal-item-status">已拒绝</span>
          <span v-else-if="p.status === 'expired'" class="proposal-item-status">⚠ 已过期</span>
        </div>
      </div>

      <!-- 新文件提议卡片 (Ticket #24b: propose_new_file) -->
      <div
        v-if="proposals.hasNewFileProposals"
        class="agent-newfile-list"
      >
        <div class="newfile-list-header">
          <svg class="newfile-list-icon" viewBox="0 0 24 24" width="12" height="12">
            <path fill="currentColor" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z M11 11h2v6h-2z M11 9h2v2h-2z"/>
          </svg>
          <span class="newfile-list-title">
            新文件提议 ({{ proposals.pendingNewFileProposals.length }})
          </span>
        </div>
        <div
          v-for="nf in proposals.newFileProposals"
          :key="nf.id"
          class="newfile-card"
          :class="{
            'newfile-pending': nf.status === 'pending',
            'newfile-written': nf.status === 'written',
            'newfile-rejected': nf.status === 'rejected',
            'newfile-error': nf.status === 'error',
          }"
        >
          <div class="newfile-card-header">
            <span class="newfile-card-icon">📄</span>
            <span class="newfile-card-label" :title="nf.label">{{ nf.label }}</span>
            <span class="newfile-card-meta">{{ nf.lineCount }} 行</span>
          </div>
          <div class="newfile-card-path" :title="nf.path">{{ nf.path }}</div>

          <!-- pending 状态：接受/拒绝按钮 -->
          <template v-if="nf.status === 'pending'">
            <div class="newfile-card-actions">
              <button
                class="newfile-btn newfile-btn-reject"
                title="拒绝"
                @click="proposals.rejectNewFileProposal(nf.id)"
              >✗ 拒绝</button>
              <button
                class="newfile-btn newfile-btn-accept"
                title="接受并创建文件"
                @click="proposals.acceptNewFileProposal(nf.id)"
              >✓ 接受</button>
            </div>
          </template>

          <!-- written 状态：显示已写入路径 -->
          <div v-else-if="nf.status === 'written'" class="newfile-card-status newfile-status-written">
            ✓ 已创建
            <span v-if="nf.writtenPath" class="newfile-written-path" :title="nf.writtenPath">
              {{ nf.writtenPath }}
            </span>
          </div>

          <!-- rejected 状态 -->
          <div v-else-if="nf.status === 'rejected'" class="newfile-card-status newfile-status-rejected">
            ✗ 已拒绝
          </div>

          <!-- error 状态：显示错误信息 + 重试按钮 -->
          <template v-else-if="nf.status === 'error'">
            <div class="newfile-card-status newfile-status-error" :title="nf.error">
              ⚠ {{ nf.error }}
            </div>
            <div class="newfile-card-actions">
              <button
                class="newfile-btn newfile-btn-retry"
                title="重试"
                @click="proposals.acceptNewFileProposal(nf.id)"
              >↻ 重试</button>
            </div>
          </template>
        </div>
      </div>

      <!-- >50 行二次确认对话框 -->
      <div
        v-if="proposals.pendingConfirmation"
        class="proposal-confirmation-overlay"
      >
        <div class="proposal-confirmation-dialog">
          <div class="confirmation-title">确认接受 {{ proposals.pendingConfirmation.lineCount }} 行替换？</div>
          <div class="confirmation-label">{{ proposals.pendingConfirmation.label }}</div>
          <div class="confirmation-buttons">
            <button
              class="confirmation-btn confirmation-cancel"
              @click="proposals.cancelConfirmation()"
            >取消</button>
            <button
              class="confirmation-btn confirmation-confirm"
              @click="proposals.confirmLargeReplace()"
            >确认替换</button>
          </div>
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

/* 上下文卡片 */
.agent-context-card {
  margin: 8px 10px 4px;
  padding: 6px 10px;
  border: 1px solid var(--murasaki-line, #e5e7eb);
  border-radius: 8px;
  background: var(--murasaki-background, #fafafa);
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--murasaki-muted, #6b7280);
}
.agent-context-icon {
  color: var(--murasaki-muted, #9ca3af);
  flex-shrink: 0;
}
.agent-context-path {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--murasaki-ink-2, #4b5563);
}
.agent-context-tokens {
  flex-shrink: 0;
  color: var(--murasaki-muted, #9ca3af);
}
.agent-context-remove {
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--murasaki-muted, #9ca3af);
  font-size: 14px;
  line-height: 1;
  border-radius: 3px;
  flex-shrink: 0;
}
.agent-context-remove:hover {
  background: var(--murasaki-hover, #f3f4f6);
  color: var(--murasaki-state-error, #dc2626);
}

/* 工具调用条目 */
.agent-tool-calls {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
  width: 100%;
}
.tool-call-entry {
  padding: 4px 8px;
  border-radius: 4px;
  background: var(--murasaki-background, #fafafa);
  border: 1px solid var(--murasaki-line, #e5e7eb);
  cursor: pointer;
  font-size: 11px;
  transition: background 0.15s;
}
.tool-call-entry:hover {
  background: var(--murasaki-hover, #f3f4f6);
}
.tool-call-calling {
  border-color: var(--murasaki-primary, #9333ea);
}
.tool-call-error {
  border-color: var(--murasaki-state-error, #dc2626);
  background: rgba(220, 38, 38, 0.04);
}
.tool-call-header {
  display: flex;
  align-items: center;
  gap: 4px;
}
.tool-call-icon {
  font-size: 10px;
}
.tool-call-name {
  font-weight: 500;
  color: var(--murasaki-ink-2, #4b5563);
}
.tool-call-summary {
  color: var(--murasaki-muted, #9ca3af);
  margin-left: auto;
}
.tool-call-detail {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--murasaki-line, #e5e7eb);
}
.tool-call-section {
  margin-bottom: 4px;
}
.tool-call-label {
  font-size: 10px;
  color: var(--murasaki-muted, #9ca3af);
  display: block;
  margin-bottom: 2px;
}
.tool-call-pre {
  font-size: 10px;
  font-family: monospace;
  background: var(--murasaki-surface, #fff);
  padding: 4px;
  border-radius: 3px;
  overflow-x: auto;
  max-height: 120px;
  overflow-y: auto;
  margin: 0;
  color: var(--murasaki-ink, #1f2937);
}

/* ===== Proposal list (Ticket #23) ===== */
.agent-proposal-list {
  flex-shrink: 0;
  max-height: 200px;
  overflow-y: auto;
  border-top: 1px solid var(--murasaki-line, #e5e7eb);
  padding: 6px 8px;
  background: var(--murasaki-purple-50, #faf5ff);
}

.proposal-list-header {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 4px;
  font-size: 11px;
  color: var(--murasaki-purple-700, #7e22ce);
  font-weight: 600;
}

.proposal-list-icon {
  color: var(--murasaki-purple-600, #9333ea);
}

.proposal-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  margin-bottom: 2px;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s;
}

.proposal-pending {
  background: rgba(168, 85, 247, 0.06);
}

.proposal-pending:hover {
  background: rgba(168, 85, 247, 0.12);
}

.proposal-accepted {
  opacity: 0.5;
  cursor: default;
}

.proposal-rejected {
  opacity: 0.3;
  cursor: default;
  text-decoration: line-through;
}

.proposal-expired {
  opacity: 0.4;
  cursor: default;
  color: var(--murasaki-state-error, #ef4444);
}

.proposal-flash {
  animation: murasaki-proposal-flash 1.5s ease-in-out;
}

.proposal-item-icon {
  color: var(--murasaki-purple-600, #9333ea);
  font-weight: 700;
  flex-shrink: 0;
}

.proposal-item-label {
  flex: 1;
  color: var(--murasaki-ink-2, #4b5563);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.proposal-item-meta {
  font-size: 10px;
  color: var(--murasaki-muted, #9ca3af);
  flex-shrink: 0;
}

.proposal-item-btn {
  border: none;
  cursor: pointer;
  width: 18px;
  height: 18px;
  border-radius: 3px;
  font-size: 11px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  flex-shrink: 0;
}

.proposal-item-accept {
  background: #22c55e;
  color: white;
}

.proposal-item-accept:hover {
  background: #16a34a;
}

.proposal-item-reject {
  background: #ef4444;
  color: white;
}

.proposal-item-reject:hover {
  background: #dc2626;
}

.proposal-item-status {
  font-size: 10px;
  color: var(--murasaki-muted, #9ca3af);
  flex-shrink: 0;
}

/* ===== >50 line confirmation dialog ===== */
.proposal-confirmation-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.proposal-confirmation-dialog {
  background: var(--murasaki-surface, #fff);
  border-radius: 8px;
  padding: 16px;
  max-width: 300px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.confirmation-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--murasaki-ink, #1f2937);
  margin-bottom: 6px;
}

.confirmation-label {
  font-size: 11px;
  color: var(--murasaki-muted, #9ca3af);
  margin-bottom: 12px;
}

.confirmation-buttons {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.confirmation-btn {
  border: none;
  border-radius: 4px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
  font-weight: 500;
}

.confirmation-cancel {
  background: var(--murasaki-neutral-200, #e5e5e5);
  color: var(--murasaki-ink-2, #4b5563);
}

.confirmation-cancel:hover {
  background: var(--murasaki-neutral-300, #d4d4d4);
}

.confirmation-confirm {
  background: var(--murasaki-purple-600, #9333ea);
  color: white;
}

.confirmation-confirm:hover {
  background: var(--murasaki-purple-700, #7e22ce);
}

/* ===== New-file proposal cards (Ticket #24b) ===== */
.agent-newfile-list {
  flex-shrink: 0;
  max-height: 240px;
  overflow-y: auto;
  border-top: 1px solid var(--murasaki-line, #e5e7eb);
  padding: 6px 8px;
  background: var(--murasaki-surface, #fff);
}

.newfile-list-header {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
  font-size: 11px;
  color: var(--murasaki-purple-700, #7e22ce);
  font-weight: 600;
}

.newfile-list-icon {
  color: var(--murasaki-purple-600, #9333ea);
}

.newfile-card {
  border: 1px solid var(--murasaki-line, #e5e7eb);
  border-radius: 6px;
  padding: 6px 8px;
  margin-bottom: 6px;
  background: var(--murasaki-background, #fafafa);
  transition: border-color 0.15s, background 0.15s;
}

.newfile-pending {
  border-color: var(--murasaki-primary, #9333ea);
  background: rgba(168, 85, 247, 0.04);
}

.newfile-written {
  border-color: #22c55e;
  background: rgba(34, 197, 94, 0.05);
}

.newfile-rejected {
  opacity: 0.5;
  background: var(--murasaki-background, #fafafa);
}

.newfile-error {
  border-color: var(--murasaki-state-error, #dc2626);
  background: rgba(220, 38, 38, 0.04);
}

.newfile-card-header {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 2px;
}

.newfile-card-icon {
  font-size: 12px;
  flex-shrink: 0;
}

.newfile-card-label {
  flex: 1;
  font-size: 12px;
  font-weight: 500;
  color: var(--murasaki-ink, #1f2937);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.newfile-card-meta {
  font-size: 10px;
  color: var(--murasaki-muted, #9ca3af);
  flex-shrink: 0;
}

.newfile-card-path {
  font-size: 10px;
  font-family: Consolas, "Courier New", monospace;
  color: var(--murasaki-muted, #6b7280);
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.newfile-card-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}

.newfile-btn {
  border: none;
  border-radius: 4px;
  padding: 3px 10px;
  font-size: 11px;
  cursor: pointer;
  font-weight: 500;
  transition: background 0.15s;
}

.newfile-btn-accept {
  background: #22c55e;
  color: white;
}

.newfile-btn-accept:hover {
  background: #16a34a;
}

.newfile-btn-reject {
  background: var(--murasaki-neutral-200, #e5e5e5);
  color: var(--murasaki-ink-2, #4b5563);
}

.newfile-btn-reject:hover {
  background: var(--murasaki-neutral-300, #d4d4d4);
}

.newfile-btn-retry {
  background: var(--murasaki-primary, #9333ea);
  color: white;
}

.newfile-btn-retry:hover {
  background: var(--murasaki-purple-700, #7e22ce);
}

.newfile-card-status {
  font-size: 11px;
  padding: 2px 0;
}

.newfile-status-written {
  color: #16a34a;
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.newfile-written-path {
  font-size: 10px;
  font-family: Consolas, "Courier New", monospace;
  color: var(--murasaki-muted, #6b7280);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.newfile-status-rejected {
  color: var(--murasaki-muted, #9ca3af);
}

.newfile-status-error {
  color: var(--murasaki-state-error, #dc2626);
  margin-bottom: 4px;
  word-break: break-word;
}
</style>
