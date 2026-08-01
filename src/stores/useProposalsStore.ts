/**
 * Proposals Store (Ticket #23 + #24)
 *
 * Bridges CM6 proposal StateField with Vue reactivity for the agent panel UI.
 * The CM6 StateField is the source of truth for decorations;
 * this store mirrors proposal metadata for the proposal list UI.
 *
 * Responsibilities:
 * - Track proposals for the agent panel list (pending/accepted/rejected/expired)
 * - Handle accept/reject actions (apply changes + update UI)
 * - Trigger >50 line secondary confirmation
 * - Emit events for jump-to-position and highlight flash
 * - Track new-file proposals (Ticket #24: propose_new_file)
 *   - Bottom card UI (separate from inline proposals)
 *   - Accept flow: try agent_write_file; on conflict, ask user via T2 dialog
 *   - Conflict resolver injected from App.vue to avoid coupling to Tauri dialog
 */
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { EditorView } from "@codemirror/view";
import { useEditorBridgeStore } from "./useEditorBridgeStore";
import { useWorkspaceStore } from "./useWorkspaceStore";
import { fileSystem } from "../services/fileSystem";
import {
  type Proposal,
  type ProposalStatus,
  addProposalEffect,
  applyProposalAcceptance,
  applyProposalRejection,
  proposalField,
} from "../agent/proposals";
import type { NewFileProposal } from "../types";

/** UI-facing proposal item (extends Proposal with UI-specific fields) */
export interface ProposalListItem {
  id: string;
  type: "insert" | "replace";
  from: number;
  to: number;
  content: string;
  status: ProposalStatus;
  lineCount: number;
  label: string;
}

/** 冲突解决器签名（注入自 App.vue 以复用 T2 ConflictDialog） */
export type NewFileConflictResolver = (
  targetPath: string
) => Promise<{ action: "overwrite" | "rename" | "cancel"; newName?: string }>;

export const useProposalsStore = defineStore("proposals", () => {
  const bridge = useEditorBridgeStore();

  /** Proposal list (mirrored from CM6 field for Vue reactivity) */
  const proposals = ref<ProposalListItem[]>([]);

  /** ID of the proposal currently being highlighted (flash animation) */
  const flashingId = ref<string | null>(null);

  /** Pending >50 line confirmation */
  const pendingConfirmation = ref<{
    proposalId: string;
    lineCount: number;
    label: string;
  } | null>(null);

  // ===== New-file proposals (Ticket #24) =====
  /** 新文件提议列表（独立于 inline proposals，不进入 CM6 StateField） */
  const newFileProposals = ref<NewFileProposal[]>([]);

  /** 冲突解决器（注入自 App.vue，复用 T2 ConflictDialog） */
  let newFileConflictResolver: NewFileConflictResolver | null = null;

  /** 注入冲突解决器 */
  function setNewFileConflictResolver(resolver: NewFileConflictResolver | null): void {
    newFileConflictResolver = resolver;
  }

  // ===== Computed =====

  const pendingProposals = computed(() =>
    proposals.value.filter((p) => p.status === "pending")
  );

  const hasProposals = computed(() => proposals.value.length > 0);

  const hasPending = computed(() => pendingProposals.value.length > 0);

  // New-file proposals computed
  const pendingNewFileProposals = computed(() =>
    newFileProposals.value.filter((p) => p.status === "pending")
  );

  const hasNewFileProposals = computed(() => newFileProposals.value.length > 0);

  // ===== Actions =====

  /**
   * Add a proposal to the editor.
   * Dispatches addProposalEffect to CM6 and updates the local list.
   */
  function addProposal(proposal: Proposal): void {
    const view = bridge.editorView;
    if (!view) return;

    view.dispatch({
      effects: addProposalEffect.of(proposal),
    });

    // Update local list
    proposals.value.push({
      id: proposal.id,
      type: proposal.type,
      from: proposal.from,
      to: proposal.to,
      content: proposal.content,
      status: proposal.status,
      lineCount: proposal.lineCount,
      label: proposal.label,
    });
  }

  /**
   * Accept a proposal.
   * If >50 lines, triggers secondary confirmation first.
   */
  function acceptProposal(proposalId: string): void {
    const proposal = proposals.value.find((p) => p.id === proposalId);
    if (!proposal || proposal.status !== "pending") return;

    // >50 line secondary confirmation
    if (proposal.type === "replace" && proposal.lineCount > 50) {
      pendingConfirmation.value = {
        proposalId: proposal.id,
        lineCount: proposal.lineCount,
        label: proposal.label,
      };
      return;
    }

    doAccept(proposalId);
  }

  /** Actually apply acceptance (after confirmation if needed) */
  function doAccept(proposalId: string): void {
    const view = bridge.editorView;
    if (!view) return;

    const proposal = proposals.value.find((p) => p.id === proposalId);
    if (!proposal || proposal.status !== "pending") return;

    // Get fresh position from CM6 state (positions may have shifted)
    const cmProposals = view.state.field(proposalField).proposals;
    const cmProposal = cmProposals.find((p) => p.id === proposalId);
    if (!cmProposal) {
      // Already removed from editor (expired)
      updateProposalStatus(proposalId, "expired");
      return;
    }

    applyProposalAcceptance(view, cmProposal);
    updateProposalStatus(proposalId, "accepted");
  }

  /** Confirm >50 line replacement */
  function confirmLargeReplace(): void {
    if (!pendingConfirmation.value) return;
    const { proposalId } = pendingConfirmation.value;
    pendingConfirmation.value = null;
    doAccept(proposalId);
  }

  /** Cancel >50 line confirmation */
  function cancelConfirmation(): void {
    pendingConfirmation.value = null;
  }

  /**
   * Reject a proposal.
   */
  function rejectProposal(proposalId: string): void {
    const view = bridge.editorView;
    if (!view) return;

    const proposal = proposals.value.find((p) => p.id === proposalId);
    if (!proposal || proposal.status !== "pending") return;

    applyProposalRejection(view, proposalId);
    updateProposalStatus(proposalId, "rejected");
  }

  /**
   * Jump to a proposal's position in the editor and flash highlight.
   */
  function jumpToProposal(proposalId: string): void {
    const view = bridge.editorView;
    if (!view) return;

    const proposal = proposals.value.find((p) => p.id === proposalId);
    if (!proposal) return;

    // Get fresh position from CM6 state
    const cmProposals = view.state.field(proposalField).proposals;
    const cmProposal = cmProposals.find((p) => p.id === proposalId);
    if (!cmProposal) return;

    // Scroll to position
    view.dispatch({
      effects: EditorView.scrollIntoView(cmProposal.from, { y: "center" }),
    });

    // Flash highlight
    flashingId.value = proposalId;
    setTimeout(() => {
      if (flashingId.value === proposalId) {
        flashingId.value = null;
      }
    }, 1500);
  }

  /**
   * Sync local list from CM6 state.
   * Called when the editor state changes externally (e.g., strict invalidation).
   */
  function syncFromEditor(): void {
    const view = bridge.editorView;
    if (!view) return;

    const cmProposals = view.state.field(proposalField).proposals;
    proposals.value = cmProposals.map((p) => ({
      id: p.id,
      type: p.type,
      from: p.from,
      to: p.to,
      content: p.content,
      status: p.status,
      lineCount: p.lineCount,
      label: p.label,
    }));
  }

  /** Clear all proposals (e.g., on tab switch) */
  function clearAll(): void {
    proposals.value = [];
    pendingConfirmation.value = null;
    flashingId.value = null;
    // 不清除 newFileProposals：它们不绑定编辑器位置，
    // 切 tab 时仍保留（用户切回还能看到/接受）。
    // 工作区切换时由 clearAllForWorkspace 清除。
  }

  /** Clear all proposals including new-file (e.g., on workspace switch) */
  function clearAllForWorkspace(): void {
    clearAll();
    newFileProposals.value = [];
  }

  // ===== New-file proposal actions (Ticket #24) =====

  /**
   * Add a new-file proposal.
   * Unlike inline proposals, these are NOT dispatched to CM6;
   * they live only in this store and are shown as bottom cards in the agent panel.
   */
  function addNewFileProposal(proposal: NewFileProposal): void {
    newFileProposals.value.push(proposal);
  }

  /**
   * Accept a new-file proposal.
   * Tries agent_write_file. On "file exists", asks user via injected conflict resolver.
   * On "path outside workspace" or other errors, marks the proposal as error.
   *
   * Can be called from "pending" or "error" status (retry).
   * Returns true if the file was written successfully.
   */
  async function acceptNewFileProposal(proposalId: string): Promise<boolean> {
    const proposal = newFileProposals.value.find((p) => p.id === proposalId);
    if (!proposal) return false;
    // 允许从 pending 或 error（重试）状态调用
    if (proposal.status !== "pending" && proposal.status !== "error") return false;
    // 重试时清空错误信息，恢复到 pending-like 状态
    if (proposal.status === "error") {
      proposal.status = "pending";
      proposal.error = undefined;
    }

    const workspace = useWorkspaceStore();
    if (!workspace.workspacePath) {
      proposal.status = "error";
      proposal.error = "No workspace open";
      return false;
    }

    let pathToWrite = proposal.path;
    let contentToWrite = proposal.content;

    // 循环处理冲突：用户可能反复选 rename 后仍冲突
    // 限制 5 次以避免无限循环
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const result = await fileSystem.writeAgentFile(
          workspace.workspacePath,
          pathToWrite,
          contentToWrite
        );
        proposal.status = "written";
        proposal.writtenPath = result.absolutePath;
        // 触发文件树刷新（新文件应出现在文件树中）
        try {
          await workspace.refreshTree();
        } catch {
          // 刷新失败不影响提案状态
        }
        return true;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg === "file exists") {
          // 走 T2 冲突对话框
          if (!newFileConflictResolver) {
            proposal.status = "error";
            proposal.error = "File exists and no conflict resolver available";
            return false;
          }
          const choice = await newFileConflictResolver(pathToWrite);
          if (choice.action === "cancel") {
            // 用户取消：保持 pending 状态，让用户可再次尝试
            return false;
          }
          if (choice.action === "rename") {
            if (!choice.newName || !choice.newName.trim()) {
              // 无效名称，保持 pending
              return false;
            }
            pathToWrite = choice.newName.trim();
            // 继续 loop 重试
            continue;
          }
          if (choice.action === "overwrite") {
            // 直接用 write_text_file 覆盖现有文件
            try {
              const absPath = await fileSystem.resolveAgentPath(
                workspace.workspacePath,
                pathToWrite
              );
              if (!absPath) {
                proposal.status = "error";
                proposal.error = "Cannot resolve path for overwrite";
                return false;
              }
              await fileSystem.writeText(absPath, contentToWrite);
              proposal.status = "written";
              proposal.writtenPath = absPath;
              try {
                await workspace.refreshTree();
              } catch {
                // ignore
              }
              return true;
            } catch (writeErr) {
              proposal.status = "error";
              proposal.error = writeErr instanceof Error ? writeErr.message : String(writeErr);
              return false;
            }
          }
        } else if (errMsg === "path outside workspace") {
          // 无效路径：标记为 error，提示用户手动保存
          proposal.status = "error";
          proposal.error = "Path outside workspace. Please use a relative path within the workspace.";
          return false;
        } else {
          proposal.status = "error";
          proposal.error = errMsg;
          return false;
        }
      }
    }
    // 达到重试上限
    proposal.status = "error";
    proposal.error = "Too many rename attempts";
    return false;
  }

  /** Reject a new-file proposal */
  function rejectNewFileProposal(proposalId: string): void {
    const proposal = newFileProposals.value.find((p) => p.id === proposalId);
    if (!proposal || proposal.status !== "pending") return;
    proposal.status = "rejected";
  }

  // ===== Internal helpers =====

  function updateProposalStatus(id: string, status: ProposalStatus): void {
    const proposal = proposals.value.find((p) => p.id === id);
    if (proposal) {
      proposal.status = status;
    }
  }

  return {
    // State
    proposals,
    flashingId,
    pendingConfirmation,
    newFileProposals,
    // Computed
    pendingProposals,
    hasProposals,
    hasPending,
    pendingNewFileProposals,
    hasNewFileProposals,
    // Actions
    addProposal,
    acceptProposal,
    confirmLargeReplace,
    cancelConfirmation,
    rejectProposal,
    jumpToProposal,
    syncFromEditor,
    clearAll,
    clearAllForWorkspace,
    // New-file proposal actions
    addNewFileProposal,
    acceptNewFileProposal,
    rejectNewFileProposal,
    setNewFileConflictResolver,
  };
});
