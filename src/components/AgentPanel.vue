<script setup lang="ts">
/**
 * Agent 面板 — 右侧 380px 固定面板
 *
 * Ticket #20: 面板 + 循环骨架 + 单轮对话 + 流式 + 取消 + 无工作区禁用
 * Ticket #69 (T4.1): 全量视觉对齐设计规范
 */
import { ref, computed, watch, nextTick, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  AlertTriangle,
  Paperclip,
  Wrench,
  FilePlus,
  Plus,
  RotateCw,
  Check,
  X,
  MessageSquare,
  ChevronDown,
  ChevronRight,
  User,
  Bot,
  Sparkles,
  Send,
  Square,
  Trash2,
  PanelRightClose,
  FileText,
  FolderOpen,
  ListChecks,
  Copy,
  Code,
  CornerDownLeft,
} from "lucide-vue-next";
import EmptyState from "./EmptyState.vue";
import { useAgentStore } from "../stores/useAgentStore";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { useAiProvidersStore } from "../stores/useAiProvidersStore";
import { useProposalsStore } from "../stores/useProposalsStore";
import { useEditorBridgeStore } from "../stores/useEditorBridgeStore";
import { useDialogStore } from "../stores/useDialogStore";
import { useContextMenuStore } from "../stores/useContextMenuStore";
import type { MenuItem } from "../stores/useContextMenuStore";
import type { ToolCallEntry } from "../types";
import type { ChatMessage } from "../types";

const agent = useAgentStore();
const workspace = useWorkspaceStore();
const aiProviders = useAiProvidersStore();
const proposals = useProposalsStore();
const editorBridge = useEditorBridgeStore();
const dialog = useDialogStore();
const contextMenu = useContextMenuStore();
const { t } = useI18n();

// ===== 输入框 =====
const inputText = ref("");
const inputRef = ref<HTMLTextAreaElement | null>(null);

// ===== 工具调用折叠卡片展开状态（按消息 ID 跟踪） =====
const expandedToolCalls = ref<Set<string>>(new Set());

function toggleToolCallCard(msgId: string): void {
  if (expandedToolCalls.value.has(msgId)) {
    expandedToolCalls.value.delete(msgId);
  } else {
    expandedToolCalls.value.add(msgId);
  }
}

/** 工具调用摘要文本 */
function toolCallsSummary(toolCalls: ToolCallEntry[]): string {
  const total = toolCalls.length;
  const calling = toolCalls.filter((t) => t.status === "calling").length;
  const error = toolCalls.filter((t) => t.status === "error").length;
  if (calling > 0) return t("agent.toolCallsSummaryCalling", { calling, total });
  if (error > 0) return t("agent.toolCallsSummaryError", { total, error });
  return t("agent.toolCallsSummaryDone", { total });
}

// ===== 提案行号范围 =====
function proposalLineRange(from: number, to: number): string {
  const view = editorBridge.editorView;
  if (!view) return "";
  try {
    const docLen = view.state.doc.length;
    const fromLine = view.state.doc.lineAt(Math.min(from, docLen)).number;
    const toLine = view.state.doc.lineAt(Math.min(to, docLen)).number;
    if (fromLine === toLine) return `L${fromLine}`;
    return `L${fromLine}-${toLine}`;
  } catch {
    return "";
  }
}

// ===== 滚动 =====
const conversationRef = ref<HTMLDivElement | null>(null);

/** 滚动到底部 */
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

// ===== 清空对话 =====
async function onClearConversation(): Promise<void> {
  if (agent.messages.length === 0) return;
  if (!(await dialog.confirm({ message: t("agent.clearConfirm"), danger: true }))) return;
  await agent.clearConversation();
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

// ===== 消息右键菜单 =====
function onMessageContextMenu(e: MouseEvent, msg: ChatMessage): void {
  const items: MenuItem[] = [
    {
      label: t("agent.contextMenu.copy"),
      icon: Copy,
      action: () => copyToClipboard(msg.content),
    },
    {
      label: t("agent.contextMenu.copyMarkdown"),
      icon: Code,
      action: () => copyToClipboard(msg.content),
    },
    {
      label: t("agent.contextMenu.insertToEditor"),
      icon: CornerDownLeft,
      action: () => insertIntoEditor(msg.content),
    },
    {
      label: t("agent.contextMenu.regenerate"),
      icon: RotateCw,
      disabled: agent.isThinking,
      action: () => regenerateFromMessage(msg),
    },
  ];
  contextMenu.show(e, items);
}

function copyToClipboard(text: string): void {
  navigator.clipboard.writeText(text).catch((err) => {
    console.warn("复制失败:", err);
  });
}

function insertIntoEditor(text: string): void {
  const view = editorBridge.editorView;
  if (!view) {
    dialog.alert({ message: t("editor.commands.openFileFirst"), variant: "warning" });
    return;
  }
  view.focus();
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from + text.length },
    userEvent: "input.paste",
  });
}

function regenerateFromMessage(msg: ChatMessage): void {
  if (agent.isThinking) return;
  const idx = agent.messages.findIndex((m) => m.id === msg.id);
  if (idx < 0) return;
  let userIdx = -1;
  let userText = "";
  if (msg.role === "user") {
    userIdx = idx;
    userText = msg.content;
  } else {
    for (let i = idx; i >= 0; i--) {
      if (agent.messages[i].role === "user") {
        userIdx = i;
        userText = agent.messages[i].content;
        break;
      }
    }
  }
  if (userIdx < 0 || !userText) return;
  agent.messages.splice(userIdx);
  void agent.sendMessage(userText);
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
        <Bot :size="15" class="agent-header-icon" />
        <span class="agent-header-title">Agent</span>
      </div>
      <div class="agent-header-right">
        <button
          v-if="agent.messages.length > 0"
          class="agent-clear-btn"
          :title="$t('agent.clearConversation')"
          @click="onClearConversation"
        >
          <Trash2 :size="14" />
        </button>
        <button class="agent-collapse-btn" :title="$t('agent.collapsePanel')" @click="onCollapse">
          <PanelRightClose :size="14" />
        </button>
      </div>
    </div>

    <!-- 上下文卡片（显示当前文档 + token 数 + × 移除） -->
    <div
      v-if="agent.hasContext && agent.contextDocPath"
      class="agent-context-card"
    >
      <FileText :size="12" class="agent-context-icon" />
      <span class="agent-context-path">{{ agent.contextDocPath }}</span>
      <span class="agent-context-tokens">{{ $t('agent.contextTokens', { count: agent.contextTokens }) }}</span>
      <button class="agent-context-remove" :title="$t('agent.removeContext')" @click="agent.removeContext()">
        <X :size="11" />
      </button>
    </div>

    <!-- 累计 token 警告 (Ticket #26) -->
    <div
      v-if="agent.isOverTokenLimit"
      class="agent-token-warning agent-token-danger"
      :title="$t('agent.tokenOverLimitTooltip')"
    >
      <AlertTriangle :size="12" class="token-warning-icon" />
      <span class="token-warning-text">
        {{ $t('agent.tokenOverLimit', { used: agent.cumulativeTokens, limit: agent.tokenLimit }) }}
      </span>
    </div>
    <div
      v-else-if="agent.isApproachingTokenLimit"
      class="agent-token-warning agent-token-caution"
      :title="$t('agent.tokenApproachingTooltip')"
    >
      <span class="token-warning-icon">!</span>
      <span class="token-warning-text">
        {{ $t('agent.tokenApproaching', { used: agent.cumulativeTokens, limit: agent.tokenLimit }) }}
      </span>
    </div>
    <!-- 压缩提示（仅在最近一次请求触发了压缩时显示） -->
    <div
      v-if="agent.lastCompression"
      class="agent-compression-badge"
      :title="$t('agent.compressionBadge')"
    >
      <Paperclip :size="12" />
      <span v-if="agent.lastCompression.layer1Applied">L1·</span>
      <span v-if="agent.lastCompression.layer2Applied">L2·</span>
      <span v-if="agent.lastCompression.truncated">{{ $t('agent.truncated') }}·</span>
      <span>{{ agent.lastCompression.compressedTokens }}/{{ agent.lastCompression.originalTokens }} tok</span>
    </div>

    <!-- 空状态：无工作区 -->
    <div v-if="showNoWorkspace" class="agent-empty-state">
      <FolderOpen :size="40" class="empty-icon" />
      <p class="empty-title">{{ $t('agent.noWorkspace.title') }}</p>
      <p class="empty-desc">{{ $t('agent.noWorkspace.desc') }}</p>
      <button class="empty-action" @click="onOpenWorkspace">{{ $t('agent.noWorkspace.action') }}</button>
    </div>

    <!-- 空状态：未配置 provider -->
    <div v-else-if="showNoProvider" class="agent-empty-state">
      <Sparkles :size="40" class="empty-icon empty-icon-dim" />
      <p class="empty-title">{{ $t('agent.noProvider.title') }}</p>
      <p class="empty-desc">{{ $t('agent.noProvider.desc') }}</p>
      <button class="empty-action" @click="onOpenSettings">{{ $t('agent.noProvider.action') }}</button>
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
        <EmptyState
          v-if="agent.messages.length === 0"
          :icon="MessageSquare"
          :title="$t('agent.emptyConversation.title')"
          :description="$t('agent.emptyConversation.desc')"
        />

        <!-- 消息列表 -->
        <template v-for="msg in agent.messages" :key="msg.id">
          <!-- 用户消息：右对齐 bg-primary + User 图标 -->
          <div v-if="msg.role === 'user'" class="agent-message agent-message-user">
            <div
              class="agent-message-bubble agent-message-bubble-user"
              @contextmenu="onMessageContextMenu($event, msg)"
            >
              {{ msg.content }}
            </div>
            <div class="agent-avatar agent-avatar-user">
              <User :size="13" />
            </div>
          </div>

          <!-- 助手消息：左对齐 bg-muted/30 + Bot 图标 -->
          <div v-else-if="msg.role === 'assistant'" class="agent-message agent-message-assistant">
            <div class="agent-avatar agent-avatar-assistant">
              <Bot :size="13" />
            </div>
            <div class="agent-message-content">
              <!-- 气泡 -->
              <div
                v-if="msg.content"
                class="agent-message-bubble agent-message-bubble-assistant"
                @contextmenu="onMessageContextMenu($event, msg)"
              >
                {{ msg.content }}
                <span v-if="msg.interrupted" class="agent-interrupted-tag">
                  <AlertTriangle :size="11" /> {{ $t('agent.interrupted') }}
                </span>
              </div>

              <!-- 工具调用折叠卡片 (T4.1) -->
              <div
                v-if="msg.toolCalls && msg.toolCalls.length > 0"
                class="tool-call-card"
              >
                <!-- 折叠态：单行 Wrench + "工具·{summary}" + ChevronDown -->
                <div
                  class="tool-call-card-header"
                  @click="toggleToolCallCard(msg.id)"
                >
                  <Wrench :size="12" class="tool-call-card-icon" />
                  <span class="tool-call-card-title">{{ $t('agent.toolCardTitle', { summary: toolCallsSummary(msg.toolCalls) }) }}</span>
                  <ChevronDown
                    v-if="expandedToolCalls.has(msg.id)"
                    :size="12"
                    class="tool-call-card-chevron"
                  />
                  <ChevronRight
                    v-else
                    :size="12"
                    class="tool-call-card-chevron"
                  />
                </div>
                <!-- 展开态：列出每个工具调用（图标+名称+参数摘要+状态色+结果预览），逐个出现 -->
                <div
                  v-if="expandedToolCalls.has(msg.id)"
                  class="tool-call-card-body"
                >
                  <div
                    v-for="(tc, idx) in msg.toolCalls"
                    :key="tc.id"
                    class="tool-call-item tool-call-entry"
                    :class="{
                      'tool-call-calling tool-call-item-calling': tc.status === 'calling',
                      'tool-call-done tool-call-item-done': tc.status === 'done',
                      'tool-call-error tool-call-item-error': tc.status === 'error',
                    }"
                    :style="{ animationDelay: `${idx * 60}ms` }"
                  >
                    <div class="tool-call-item-row">
                      <Wrench :size="10" class="tool-call-item-icon" />
                      <span class="tool-call-item-name">{{ tc.name }}</span>
                      <span class="tool-call-summary tool-call-item-summary">
                        {{ tc.status === "calling" ? $t('agent.toolCallCalling') : tc.summary }}
                      </span>
                    </div>
                    <div class="tool-call-detail">
                      <div v-if="tc.parsedArgs" class="tool-call-section">
                        <span class="tool-call-label">{{ $t('agent.toolCallArgs') }}</span>
                        <pre class="tool-call-pre">{{ JSON.stringify(tc.parsedArgs, null, 2) }}</pre>
                      </div>
                      <div v-if="tc.result" class="tool-call-section">
                        <span class="tool-call-label">{{ $t('agent.toolCallResult') }}</span>
                        <pre class="tool-call-pre">{{ JSON.stringify(tc.result, null, 2).slice(0, 500) }}</pre>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>

        <!-- 流式中的消息 -->
        <div
          v-if="agent.isThinking && agent.streamingContent"
          class="agent-message agent-message-assistant"
        >
          <div class="agent-avatar agent-avatar-assistant">
            <Bot :size="13" />
          </div>
          <div class="agent-message-content">
            <div class="agent-message-bubble agent-message-bubble-assistant">
              {{ agent.streamingContent }}<span class="streaming-cursor"></span>
            </div>
          </div>
        </div>

        <!-- thinking 但无内容时显示等待指示器 -->
        <div
          v-if="agent.isThinking && !agent.streamingContent"
          class="agent-message agent-message-assistant"
        >
          <div class="agent-avatar agent-avatar-assistant">
            <Bot :size="13" />
          </div>
          <div class="agent-message-content">
            <div class="agent-message-bubble agent-message-bubble-assistant">
              <span class="agent-thinking-dots">{{ $t('agent.thinking') }}</span>
            </div>
          </div>
        </div>

        <!-- 错误信息 -->
        <div v-if="agent.errorMessage" class="agent-error">
          {{ agent.errorMessage }}
        </div>
      </div>

      <!-- 提议列表卡片 (T4.1: 独立卡片，每行含文件名+行号范围+类型图标+接受/拒绝状态) -->
      <div
        v-if="proposals.hasProposals"
        class="agent-proposal-list"
      >
        <div class="proposal-list-header">
          <ListChecks :size="12" class="proposal-list-icon" />
          <span class="proposal-list-title">{{ $t('agent.proposals.title', { count: proposals.pendingProposals.length }) }}</span>
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
          <span class="proposal-item-icon"><Plus v-if="p.type === 'insert'" :size="11" /><RotateCw v-else :size="11" /></span>
          <span class="proposal-item-label">{{ p.label }}</span>
          <span class="proposal-item-lines">{{ proposalLineRange(p.from, p.to) || $t('agent.proposals.lines', { count: p.lineCount }) }}</span>
          <template v-if="p.status === 'pending'">
            <button
              class="proposal-item-btn proposal-item-accept"
              :title="$t('agent.proposals.accept')"
              @click.stop="proposals.acceptProposal(p.id)"
            ><Check :size="11" /></button>
            <button
              class="proposal-item-btn proposal-item-reject"
              :title="$t('agent.proposals.reject')"
              @click.stop="proposals.rejectProposal(p.id)"
            ><X :size="11" /></button>
          </template>
          <span v-else-if="p.status === 'accepted'" class="proposal-item-status">{{ $t('agent.proposals.accepted') }}</span>
          <span v-else-if="p.status === 'rejected'" class="proposal-item-status">{{ $t('agent.proposals.rejected') }}</span>
          <span v-else-if="p.status === 'expired'" class="proposal-item-status"><AlertTriangle :size="10" /> {{ $t('agent.proposals.expired') }}</span>
        </div>
      </div>

      <!-- 新文件提议卡片 (Ticket #24b: propose_new_file) -->
      <div
        v-if="proposals.hasNewFileProposals"
        class="agent-newfile-list"
      >
        <div class="newfile-list-header">
          <FilePlus :size="12" class="newfile-list-icon" />
          <span class="newfile-list-title">
            {{ $t('agent.newFileProposals.title', { count: proposals.pendingNewFileProposals.length }) }}
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
            <FilePlus :size="12" class="newfile-card-icon" />
            <span class="newfile-card-label" :title="nf.label">{{ nf.label }}</span>
            <span class="newfile-card-meta">{{ $t('agent.newFileProposals.lines', { count: nf.lineCount }) }}</span>
          </div>
          <div class="newfile-card-path" :title="nf.path">{{ nf.path }}</div>

          <!-- pending 状态：接受/拒绝按钮 -->
          <template v-if="nf.status === 'pending'">
            <div class="newfile-card-actions">
              <button
                class="newfile-btn newfile-btn-reject"
                :title="$t('agent.newFileProposals.reject')"
                @click="proposals.rejectNewFileProposal(nf.id)"
              ><X :size="11" /> {{ $t('agent.newFileProposals.reject') }}</button>
              <button
                class="newfile-btn newfile-btn-accept"
                :title="$t('agent.newFileProposals.acceptTitle')"
                @click="proposals.acceptNewFileProposal(nf.id)"
              ><Check :size="11" /> {{ $t('agent.newFileProposals.accept') }}</button>
            </div>
          </template>

          <!-- written 状态：显示已写入路径 -->
          <div v-else-if="nf.status === 'written'" class="newfile-card-status newfile-status-written">
            <Check :size="11" /> {{ $t('agent.newFileProposals.created') }}
            <span v-if="nf.writtenPath" class="newfile-written-path" :title="nf.writtenPath">
              {{ nf.writtenPath }}
            </span>
          </div>

          <!-- rejected 状态 -->
          <div v-else-if="nf.status === 'rejected'" class="newfile-card-status newfile-status-rejected">
            <X :size="11" /> {{ $t('agent.newFileProposals.rejected') }}
          </div>

          <!-- error 状态：显示错误信息 + 重试按钮 -->
          <template v-else-if="nf.status === 'error'">
            <div class="newfile-card-status newfile-status-error" :title="nf.error">
              <AlertTriangle :size="11" /> {{ nf.error }}
            </div>
            <div class="newfile-card-actions">
              <button
                class="newfile-btn newfile-btn-retry"
                :title="$t('agent.newFileProposals.retry')"
                @click="proposals.acceptNewFileProposal(nf.id)"
              ><RotateCw :size="11" /> {{ $t('agent.newFileProposals.retry') }}</button>
            </div>
          </template>
        </div>
      </div>

      <!-- >50 行二次确认对话框 (T4.1: Check 绿色 + X 红色图标按钮) -->
      <div
        v-if="proposals.pendingConfirmation"
        class="proposal-confirmation-overlay"
      >
        <div class="proposal-confirmation-dialog">
          <div class="confirmation-title">{{ $t('agent.proposals.confirmTitle', { count: proposals.pendingConfirmation.lineCount }) }}</div>
          <div class="confirmation-label">{{ proposals.pendingConfirmation.label }}</div>
          <div class="confirmation-buttons">
            <button
              class="confirmation-btn confirmation-cancel"
              :title="$t('common.cancel')"
              @click="proposals.cancelConfirmation()"
            ><X :size="14" /></button>
            <button
              class="confirmation-btn confirmation-confirm"
              :title="$t('agent.proposals.confirmReplace')"
              @click="proposals.confirmLargeReplace()"
            ><Check :size="14" /></button>
          </div>
        </div>
      </div>

      <!-- ↓ 新内容按钮 -->
      <div
        v-if="agent.hasNewContent"
        class="agent-new-content-btn"
        @click="onClickNewContent"
      >
        {{ $t('agent.newContent') }}
      </div>

      <!-- Provider chip (T4.1: bg-primary/10 text-primary + Sparkles 图标 + provider 名) -->
      <div v-if="aiProviders.activeProvider" class="provider-chip">
        <Sparkles :size="11" />
        <span>{{ aiProviders.activeProvider.name }}</span>
      </div>

      <!-- 输入区 -->
      <div class="agent-input-area">
        <div class="agent-input-wrapper">
          <textarea
            ref="inputRef"
            v-model="inputText"
            class="agent-input"
            :placeholder="$t('agent.inputPlaceholder')"
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
          <Send :size="16" />
        </button>
        <button
          v-else
          class="agent-send-btn agent-send-btn-stop"
          @click="onStop"
          :title="$t('agent.stop')"
        >
          <Square :size="14" />
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
  position: relative;
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
.agent-header-right {
  display: flex;
  align-items: center;
  gap: 2px;
}
.agent-clear-btn,
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
  color: var(--murasaki-muted-foreground, #737373);
  transition: background var(--murasaki-transition-fast, 120ms ease),
    color var(--murasaki-transition-fast, 120ms ease);
}
.agent-clear-btn:hover {
  background: var(--murasaki-muted, #f5f5f5);
  color: var(--murasaki-state-error, #dc2626);
}
.agent-collapse-btn:hover {
  background: var(--murasaki-muted, #f5f5f5);
  color: var(--murasaki-ink, #171717);
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
  color: var(--murasaki-muted-foreground, #a3a3a3);
  margin-bottom: 8px;
}
.empty-icon-dim {
  opacity: 0.4;
}
.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--murasaki-ink, #171717);
  margin: 0;
}
.empty-desc {
  font-size: 12px;
  color: var(--murasaki-muted-foreground, #737373);
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
  transition: background var(--murasaki-transition-fast, 120ms ease);
}
.empty-action:hover {
  background: color-mix(in srgb, var(--murasaki-primary, #9333ea) 6%, transparent);
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
  color: var(--murasaki-muted-foreground, #a3a3a3);
  font-size: 12px;
}

/* ===== 消息 (T4.1: 用户/助手消息气泡区分) ===== */
.agent-message {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 6px;
}
.agent-message-user {
  justify-content: flex-end;
}
.agent-message-assistant {
  justify-content: flex-start;
}

/* 助手消息内容列（气泡 + 工具调用卡片） */
.agent-message-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1;
}

/* 头像 (T4.1: User + Bot 图标) */
.agent-avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 2px;
}
.agent-avatar-user {
  background: var(--murasaki-muted, #f5f5f5);
  color: var(--murasaki-muted-foreground, #737373);
}
.agent-avatar-assistant {
  background: var(--murasaki-primary, #9333ea);
  color: var(--murasaki-primary-foreground, #ffffff);
}

/* 气泡 (T4.1: 用户 bg-primary text-primary-foreground / 助手 bg-muted/30) */
.agent-message-bubble {
  padding: 8px 12px;
  font-size: 13px;
  line-height: 1.55;
  border-radius: 8px;
  word-break: break-word;
  white-space: pre-wrap;
}
.agent-message-bubble-user {
  background: var(--murasaki-primary, #9333ea);
  color: var(--murasaki-primary-foreground, #ffffff);
  border-bottom-right-radius: 4px;
  max-width: 80%;
}
.agent-message-bubble-assistant {
  background: color-mix(in srgb, var(--murasaki-muted, #f5f5f5) 30%, transparent);
  color: var(--murasaki-ink, #171717);
  border-bottom-left-radius: 4px;
  max-width: 85%;
}

/* 中断标签 (T4.1: AlertTriangle + text-state-warning) */
.agent-interrupted-tag {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 4px;
  color: var(--murasaki-state-warning, #d97706);
  font-size: 11px;
  font-weight: 500;
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
  color: var(--murasaki-muted-foreground, #a3a3a3);
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

/* ===== Provider chip (T4.1: bg-primary/10 text-primary + Sparkles) ===== */
.provider-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  margin: 4px 10px 0;
  align-self: flex-start;
  background: color-mix(in srgb, var(--murasaki-primary, #9333ea) 10%, transparent);
  color: var(--murasaki-primary, #9333ea);
  border-radius: var(--murasaki-radius-sm, 4px);
  font-size: 12px;
  font-weight: 500;
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
  color: var(--murasaki-ink, #171717);
}
.agent-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 发送 / 停止按钮 (T4.1: Send / Square lucide 图标) */
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
  color: var(--murasaki-muted-foreground, #737373);
}
.agent-context-icon {
  color: var(--murasaki-muted-foreground, #a3a3a3);
  flex-shrink: 0;
}
.agent-context-path {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--murasaki-ink-2, #525252);
}
.agent-context-tokens {
  flex-shrink: 0;
  color: var(--murasaki-muted-foreground, #a3a3a3);
}
.agent-context-remove {
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--murasaki-muted-foreground, #a3a3a3);
  border-radius: 3px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.agent-context-remove:hover {
  background: var(--murasaki-muted, #f5f5f5);
  color: var(--murasaki-state-error, #dc2626);
}

/* Ticket #26: 累计 token 警告 */
.agent-token-warning {
  margin: 4px 10px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.agent-token-caution {
  background: rgba(245, 158, 11, 0.1);
  color: #b45309;
  border: 1px solid rgba(245, 158, 11, 0.3);
}
.agent-token-danger {
  background: rgba(220, 38, 38, 0.1);
  color: #b91c1c;
  border: 1px solid rgba(220, 38, 38, 0.3);
}
.token-warning-icon {
  font-weight: 700;
  flex-shrink: 0;
}
.token-warning-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 压缩提示徽章 */
.agent-compression-badge {
  margin: 2px 10px 4px;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 10px;
  background: rgba(147, 51, 234, 0.08);
  color: var(--murasaki-primary, #9333ea);
  border: 1px solid rgba(147, 51, 234, 0.2);
  display: flex;
  align-items: center;
  gap: 2px;
}

/* ===== 工具调用折叠卡片 (T4.1) ===== */
.tool-call-card {
  border: 1px solid var(--murasaki-line, #e5e5e5);
  border-radius: 6px;
  background: var(--murasaki-surface, #f9fafb);
  overflow: hidden;
  max-width: 85%;
}
.tool-call-card-header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  cursor: pointer;
  font-size: 11px;
  color: var(--murasaki-ink-2, #525252);
  transition: background var(--murasaki-transition-fast, 120ms ease);
  user-select: none;
}
.tool-call-card-header:hover {
  background: var(--murasaki-muted, #f5f5f5);
}
.tool-call-card-icon {
  color: var(--murasaki-muted-foreground, #737373);
  flex-shrink: 0;
}
.tool-call-card-title {
  flex: 1;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tool-call-card-chevron {
  color: var(--murasaki-muted-foreground, #737373);
  flex-shrink: 0;
}
.tool-call-card-body {
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-top: 1px solid var(--murasaki-line, #e5e5e5);
}

/* 单个工具调用条目（展开态，逐个出现） */
.tool-call-item {
  padding: 4px 6px;
  border-radius: 4px;
  background: var(--murasaki-background, #ffffff);
  border-left: 2px solid var(--murasaki-line, #e5e5e5);
  font-size: 11px;
  animation: murasaki-fade-in 200ms ease-out both;
}
.tool-call-item-calling {
  border-left-color: var(--murasaki-primary, #9333ea);
}
.tool-call-item-done {
  border-left-color: var(--murasaki-state-success, #16a34a);
}
.tool-call-item-error {
  border-left-color: var(--murasaki-state-error, #dc2626);
  background: rgba(220, 38, 38, 0.04);
}
.tool-call-item-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.tool-call-item-icon {
  color: var(--murasaki-muted-foreground, #737373);
  flex-shrink: 0;
}
.tool-call-item-name {
  font-weight: 500;
  color: var(--murasaki-ink-2, #525252);
}
.tool-call-item-summary {
  color: var(--murasaki-muted-foreground, #737373);
  margin-left: auto;
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 120px;
}
.tool-call-detail {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid var(--murasaki-line, #e5e5e5);
}
.tool-call-section {
  margin-bottom: 4px;
}
.tool-call-label {
  font-size: 10px;
  color: var(--murasaki-muted-foreground, #737373);
  display: block;
  margin-bottom: 2px;
}
.tool-call-pre {
  font-size: 10px;
  font-family: var(--murasaki-font-mono, monospace);
  background: var(--murasaki-surface-2, #f3f4f6);
  padding: 4px;
  border-radius: 3px;
  overflow-x: auto;
  max-height: 100px;
  overflow-y: auto;
  margin: 0;
  color: var(--murasaki-ink, #171717);
  white-space: pre-wrap;
  word-break: break-all;
}

/* ===== Proposal list (T4.1: 独立卡片，文件名+行号范围+类型图标+接受/拒绝) ===== */
.agent-proposal-list {
  flex-shrink: 0;
  max-height: 200px;
  overflow-y: auto;
  border-top: 1px solid var(--murasaki-line, #e5e7eb);
  padding: 6px 8px;
  background: color-mix(in srgb, var(--murasaki-primary, #9333ea) 3%, var(--murasaki-surface, #fff));
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
  display: inline-flex;
  align-items: center;
}

.proposal-item-label {
  flex: 1;
  color: var(--murasaki-ink-2, #4b5563);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.proposal-item-lines {
  font-size: 10px;
  color: var(--murasaki-muted-foreground, #a3a3a3);
  flex-shrink: 0;
  font-family: var(--murasaki-font-mono, monospace);
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
  background: var(--murasaki-state-success, #16a34a);
  color: white;
}

.proposal-item-accept:hover {
  background: #15803d;
}

.proposal-item-reject {
  background: var(--murasaki-state-error, #dc2626);
  color: white;
}

.proposal-item-reject:hover {
  background: #b91c1c;
}

.proposal-item-status {
  font-size: 10px;
  color: var(--murasaki-muted-foreground, #a3a3a3);
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

/* ===== >50 line confirmation dialog (T4.1: Check 绿色 + X 红色图标按钮) ===== */
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
  color: var(--murasaki-ink, #171717);
  margin-bottom: 6px;
}

.confirmation-label {
  font-size: 11px;
  color: var(--murasaki-muted-foreground, #a3a3a3);
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
  width: 32px;
  height: 32px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  transition: background 0.15s;
}

.confirmation-cancel {
  background: var(--murasaki-state-error, #dc2626);
}

.confirmation-cancel:hover {
  background: #b91c1c;
}

.confirmation-confirm {
  background: var(--murasaki-state-success, #16a34a);
}

.confirmation-confirm:hover {
  background: #15803d;
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
  border-color: var(--murasaki-state-success, #16a34a);
  background: rgba(22, 163, 74, 0.05);
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
  color: var(--murasaki-ink, #171717);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.newfile-card-meta {
  font-size: 10px;
  color: var(--murasaki-muted-foreground, #a3a3a3);
  flex-shrink: 0;
}

.newfile-card-path {
  font-size: 10px;
  font-family: var(--murasaki-font-mono, monospace);
  color: var(--murasaki-muted-foreground, #737373);
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
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.newfile-btn-accept {
  background: var(--murasaki-state-success, #16a34a);
  color: white;
}

.newfile-btn-accept:hover {
  background: #15803d;
}

.newfile-btn-reject {
  background: var(--murasaki-neutral-200, #e5e5e5);
  color: var(--murasaki-ink-2, #525252);
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
  color: var(--murasaki-state-success, #16a34a);
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.newfile-written-path {
  font-size: 10px;
  font-family: var(--murasaki-font-mono, monospace);
  color: var(--murasaki-muted-foreground, #737373);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.newfile-status-rejected {
  color: var(--murasaki-muted-foreground, #a3a3a3);
}

.newfile-status-error {
  color: var(--murasaki-state-error, #dc2626);
  margin-bottom: 4px;
  word-break: break-word;
}
</style>
