/**
 * useProposalsStore 单元测试 (Ticket #24b)
 *
 * 重点测试新文件提议的状态管理：
 * - addNewFileProposal / rejectNewFileProposal
 * - acceptNewFileProposal 的重试逻辑（从 error 状态重试）
 * - clearAllForWorkspace 清除新文件提议
 * - setNewFileConflictResolver 注入与使用
 * - pendingNewFileProposals / hasNewFileProposals 计算属性
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

// Mock fileSystem（acceptNewFileProposal 会调用 writeAgentFile / writeText / resolveAgentPath）
vi.mock("../services/fileSystem", () => ({
  fileSystem: {
    writeAgentFile: vi.fn(),
    writeText: vi.fn().mockResolvedValue(undefined),
    resolveAgentPath: vi.fn().mockResolvedValue(null),
  },
}));

// Mock useWorkspaceStore
vi.mock("./useWorkspaceStore", () => ({
  useWorkspaceStore: () => ({
    workspacePath: "/workspace",
    refreshTree: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Mock useEditorBridgeStore（proposals store 初始化时需要）
vi.mock("./useEditorBridgeStore", () => ({
  useEditorBridgeStore: () => ({
    editorView: null,
    activeDocPath: null,
  }),
}));

// Mock proposals.ts 的 CM6 相关函数（不依赖真实 CM6）
vi.mock("../agent/proposals", () => ({
  addProposalEffect: vi.fn(),
  applyProposalAcceptance: vi.fn(),
  applyProposalRejection: vi.fn(),
  proposalField: { value: { proposals: [] } },
}));

import { useProposalsStore } from "./useProposalsStore";
import { fileSystem } from "../services/fileSystem";
import type { NewFileProposal } from "../types";

function makeNewFileProposal(overrides: Partial<NewFileProposal> = {}): NewFileProposal {
  return {
    id: `nf-test-${Math.random().toString(36).slice(2, 8)}`,
    path: "notes/new.md",
    content: "# New Note\n\nHello",
    label: "创建 new.md",
    lineCount: 3,
    status: "pending",
    ...overrides,
  };
}

describe("useProposalsStore - 新文件提议", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  describe("addNewFileProposal", () => {
    it("添加提议到列表", () => {
      const store = useProposalsStore();
      const proposal = makeNewFileProposal();
      store.addNewFileProposal(proposal);
      expect(store.newFileProposals).toHaveLength(1);
      expect(store.newFileProposals[0]).toEqual(proposal);
    });

    it("添加多个提议", () => {
      const store = useProposalsStore();
      store.addNewFileProposal(makeNewFileProposal({ id: "nf-1" }));
      store.addNewFileProposal(makeNewFileProposal({ id: "nf-2" }));
      expect(store.newFileProposals).toHaveLength(2);
    });
  });

  describe("计算属性", () => {
    it("hasNewFileProposals 反映列表状态", () => {
      const store = useProposalsStore();
      expect(store.hasNewFileProposals).toBe(false);
      store.addNewFileProposal(makeNewFileProposal());
      expect(store.hasNewFileProposals).toBe(true);
    });

    it("pendingNewFileProposals 只返回 pending 状态", () => {
      const store = useProposalsStore();
      store.addNewFileProposal(makeNewFileProposal({ id: "nf-1", status: "pending" }));
      store.addNewFileProposal(makeNewFileProposal({ id: "nf-2", status: "written" }));
      store.addNewFileProposal(makeNewFileProposal({ id: "nf-3", status: "rejected" }));
      store.addNewFileProposal(makeNewFileProposal({ id: "nf-4", status: "error" }));
      expect(store.pendingNewFileProposals).toHaveLength(1);
      expect(store.pendingNewFileProposals[0].id).toBe("nf-1");
    });
  });

  describe("rejectNewFileProposal", () => {
    it("将 pending 提议标记为 rejected", () => {
      const store = useProposalsStore();
      const proposal = makeNewFileProposal({ id: "nf-1" });
      store.addNewFileProposal(proposal);
      store.rejectNewFileProposal("nf-1");
      expect(store.newFileProposals[0].status).toBe("rejected");
    });

    it("拒绝不存在的提议为空操作", () => {
      const store = useProposalsStore();
      store.rejectNewFileProposal("nonexistent");
      expect(store.newFileProposals).toHaveLength(0);
    });

    it("拒绝非 pending 状态的提议为空操作", () => {
      const store = useProposalsStore();
      store.addNewFileProposal(makeNewFileProposal({ id: "nf-1", status: "written" }));
      store.rejectNewFileProposal("nf-1");
      expect(store.newFileProposals[0].status).toBe("written");
    });
  });

  describe("acceptNewFileProposal - 重试逻辑", () => {
    it("允许从 error 状态重试（清空 error 信息）", async () => {
      const store = useProposalsStore();
      const proposal = makeNewFileProposal({
        id: "nf-retry",
        status: "error",
        error: "Previous error",
      });
      store.addNewFileProposal(proposal);

      // Mock writeAgentFile 成功
      vi.mocked(fileSystem.writeAgentFile).mockResolvedValue({
        docPath: "notes/new.md",
        absolutePath: "/workspace/notes/new.md",
        contentLength: 15,
      });

      const result = await store.acceptNewFileProposal("nf-retry");
      expect(result).toBe(true);
      expect(store.newFileProposals[0].status).toBe("written");
      expect(store.newFileProposals[0].error).toBeUndefined();
      expect(store.newFileProposals[0].writtenPath).toBe("/workspace/notes/new.md");
    });

    it("拒绝从 written 状态再次 accept", async () => {
      const store = useProposalsStore();
      store.addNewFileProposal(
        makeNewFileProposal({
          id: "nf-written",
          status: "written",
          writtenPath: "/workspace/notes/new.md",
        })
      );
      const result = await store.acceptNewFileProposal("nf-written");
      expect(result).toBe(false);
      expect(store.newFileProposals[0].status).toBe("written");
    });

    it("拒绝从 rejected 状态 accept", async () => {
      const store = useProposalsStore();
      store.addNewFileProposal(
        makeNewFileProposal({ id: "nf-rejected", status: "rejected" })
      );
      const result = await store.acceptNewFileProposal("nf-rejected");
      expect(result).toBe(false);
      expect(store.newFileProposals[0].status).toBe("rejected");
    });

    it("不存在提议返回 false", async () => {
      const store = useProposalsStore();
      const result = await store.acceptNewFileProposal("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("acceptNewFileProposal - 成功路径", () => {
    it("成功写入文件后状态变为 written", async () => {
      const store = useProposalsStore();
      store.addNewFileProposal(
        makeNewFileProposal({
          id: "nf-success",
          path: "notes/success.md",
          content: "# Success",
        })
      );

      vi.mocked(fileSystem.writeAgentFile).mockResolvedValue({
        docPath: "notes/success.md",
        absolutePath: "/workspace/notes/success.md",
        contentLength: 9,
      });

      const result = await store.acceptNewFileProposal("nf-success");
      expect(result).toBe(true);
      expect(store.newFileProposals[0].status).toBe("written");
      expect(store.newFileProposals[0].writtenPath).toBe("/workspace/notes/success.md");
      expect(fileSystem.writeAgentFile).toHaveBeenCalledWith(
        "/workspace",
        "notes/success.md",
        "# Success"
      );
    });
  });

  describe("acceptNewFileProposal - 冲突解决", () => {
    it("file exists 错误时调用注入的冲突解决器", async () => {
      const store = useProposalsStore();
      store.addNewFileProposal(
        makeNewFileProposal({ id: "nf-conflict", path: "exists.md" })
      );

      // 第一次调用报 file exists，第二次（rename 后）成功
      vi.mocked(fileSystem.writeAgentFile)
        .mockRejectedValueOnce(new Error("file exists"))
        .mockResolvedValueOnce({
          docPath: "exists-renamed.md",
          absolutePath: "/workspace/exists-renamed.md",
          contentLength: 9,
        });

      // 注入冲突解决器：用户选择 rename
      store.setNewFileConflictResolver(async () => ({
        action: "rename",
        newName: "exists-renamed.md",
      }));

      const result = await store.acceptNewFileProposal("nf-conflict");
      expect(result).toBe(true);
      expect(store.newFileProposals[0].status).toBe("written");
      expect(store.newFileProposals[0].writtenPath).toBe("/workspace/exists-renamed.md");
    });

    it("用户选择 cancel 时保持 pending 状态", async () => {
      const store = useProposalsStore();
      store.addNewFileProposal(
        makeNewFileProposal({ id: "nf-cancel", path: "exists.md" })
      );

      vi.mocked(fileSystem.writeAgentFile).mockRejectedValueOnce(
        new Error("file exists")
      );

      store.setNewFileConflictResolver(async () => ({ action: "cancel" }));

      const result = await store.acceptNewFileProposal("nf-cancel");
      expect(result).toBe(false);
      expect(store.newFileProposals[0].status).toBe("pending");
    });

    it("无冲突解决器时标记为 error", async () => {
      const store = useProposalsStore();
      store.addNewFileProposal(
        makeNewFileProposal({ id: "nf-no-resolver", path: "exists.md" })
      );

      vi.mocked(fileSystem.writeAgentFile).mockRejectedValueOnce(
        new Error("file exists")
      );

      // 不注入冲突解决器
      const result = await store.acceptNewFileProposal("nf-no-resolver");
      expect(result).toBe(false);
      expect(store.newFileProposals[0].status).toBe("error");
      expect(store.newFileProposals[0].error).toContain("no conflict resolver");
    });

    it("path outside workspace 错误标记为 error", async () => {
      const store = useProposalsStore();
      store.addNewFileProposal(
        makeNewFileProposal({ id: "nf-outside", path: "../outside.md" })
      );

      vi.mocked(fileSystem.writeAgentFile).mockRejectedValueOnce(
        new Error("path outside workspace")
      );

      const result = await store.acceptNewFileProposal("nf-outside");
      expect(result).toBe(false);
      expect(store.newFileProposals[0].status).toBe("error");
      expect(store.newFileProposals[0].error).toContain("Path outside workspace");
    });
  });

  describe("clearAllForWorkspace", () => {
    it("清除所有新文件提议", () => {
      const store = useProposalsStore();
      store.addNewFileProposal(makeNewFileProposal({ id: "nf-1" }));
      store.addNewFileProposal(makeNewFileProposal({ id: "nf-2" }));
      expect(store.newFileProposals).toHaveLength(2);

      store.clearAllForWorkspace();
      expect(store.newFileProposals).toHaveLength(0);
      expect(store.hasNewFileProposals).toBe(false);
    });
  });

  describe("setNewFileConflictResolver", () => {
    it("可以注入和移除冲突解决器", async () => {
      const store = useProposalsStore();
      const resolver = vi.fn().mockResolvedValue({ action: "cancel" });
      store.setNewFileConflictResolver(resolver);
      store.addNewFileProposal(
        makeNewFileProposal({ id: "nf-test", path: "exists.md" })
      );

      vi.mocked(fileSystem.writeAgentFile).mockRejectedValueOnce(
        new Error("file exists")
      );

      await store.acceptNewFileProposal("nf-test");
      expect(resolver).toHaveBeenCalledWith("exists.md");

      // 移除解决器
      store.setNewFileConflictResolver(null);
      vi.clearAllMocks();
      vi.mocked(fileSystem.writeAgentFile).mockRejectedValueOnce(
        new Error("file exists")
      );

      // 此时再触发冲突应该走 error 路径
      store.addNewFileProposal(
        makeNewFileProposal({ id: "nf-test-2", path: "exists.md" })
      );
      const result = await store.acceptNewFileProposal("nf-test-2");
      expect(result).toBe(false);
      expect(store.newFileProposals[1].status).toBe("error");
    });
  });
});
