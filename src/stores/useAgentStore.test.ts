import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useAgentStore } from "./useAgentStore";
import { useWorkspaceStore } from "./useWorkspaceStore";
import { useEditorBridgeStore } from "./useEditorBridgeStore";

// Mock Tauri invoke
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockImplementation((cmd: string) => {
    // 对话持久化命令的默认返回值
    if (cmd === "load_chat") {
      return Promise.resolve({ messages_json: "[]", message_count: 0 });
    }
    if (cmd === "save_chat") {
      return Promise.resolve({ hash: "test", message_count: 0, file_size: 0 });
    }
    if (cmd === "delete_chat") {
      return Promise.resolve(true);
    }
    if (cmd === "check_orphan_chats") {
      return Promise.resolve({ orphan_count: 0, orphans: [] });
    }
    if (cmd === "cleanup_orphan_chats") {
      return Promise.resolve(0);
    }
    return Promise.resolve(undefined);
  }),
}));

// Mock createProvider（ADR-0011: useAgentStore 改用 createProvider 工厂）
vi.mock("../agent/Provider", () => ({
  createProvider: vi.fn().mockImplementation(() => ({
    streamChat: vi.fn(),
    streamChatWithTools: vi.fn().mockResolvedValue({
      hasToolCalls: false,
      toolCalls: [],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }),
  })),
}));

// Mock agent tools - 工具调用测试用
vi.mock("../agent/tools", () => ({
  getToolMetadataList: () => [],
  executeTool: vi.fn(),
}));

describe("useAgentStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  describe("初始状态", () => {
    it("初始 status 为 idle", () => {
      const store = useAgentStore();
      expect(store.status).toBe("idle");
    });

    it("初始 messages 为空数组", () => {
      const store = useAgentStore();
      expect(store.messages).toHaveLength(0);
    });

    it("初始 streamingContent 为空字符串", () => {
      const store = useAgentStore();
      expect(store.streamingContent).toBe("");
    });
  });

  describe("canSend", () => {
    it("无工作区时 canSend 为 false", () => {
      const store = useAgentStore();
      const ws = useWorkspaceStore();
      ws.workspacePath = null;
      expect(store.canSend).toBe(false);
    });

    it("有工作区但 status 为 thinking 时 canSend 为 false", () => {
      const store = useAgentStore();
      const ws = useWorkspaceStore();
      ws.workspacePath = "/test";
      store.status = "thinking";
      expect(store.canSend).toBe(false);
    });

    it("有工作区且 status 为 idle 时 canSend 为 true", () => {
      const store = useAgentStore();
      const ws = useWorkspaceStore();
      ws.workspacePath = "/test";
      store.status = "idle";
      expect(store.canSend).toBe(true);
    });
  });

  describe("clearConversation", () => {
    it("清空消息和状态", () => {
      const store = useAgentStore();
      store.messages = [
        { id: "1", role: "user", content: "hi", createdAt: 0 },
      ];
      store.status = "error";
      store.clearConversation();
      expect(store.messages).toHaveLength(0);
      expect(store.status).toBe("idle");
      expect(store.streamingContent).toBe("");
    });
  });

  describe("isAtBottom", () => {
    it("默认 isAtBottom 为 true", () => {
      const store = useAgentStore();
      expect(store.isAtBottom).toBe(true);
    });

    it("setScrollPosition 更新 isAtBottom 和 hasNewContent", () => {
      const store = useAgentStore();
      store.setScrollPosition(false, true);
      expect(store.isAtBottom).toBe(false);
      // hasNewContent 仅在非底部且有新内容时为 true
    });
  });

  describe("上下文管理 (Ticket #21)", () => {
    it("contextRemoved 默认为 false", () => {
      const store = useAgentStore();
      expect(store.contextRemoved).toBe(false);
    });

    it("removeContext 设置 contextRemoved 为 true（仅本轮）", () => {
      const store = useAgentStore();
      store.removeContext();
      expect(store.contextRemoved).toBe(true);
      expect(store.hasContext).toBe(false);
    });

    it("clearConversation 重置 contextRemoved", () => {
      const store = useAgentStore();
      store.removeContext();
      store.clearConversation();
      expect(store.contextRemoved).toBe(false);
    });

    it("hasContext 在无文档路径时为 false", () => {
      const store = useAgentStore();
      const bridge = useEditorBridgeStore();
      bridge.activeDocPath = null;
      expect(store.hasContext).toBe(false);
    });

    it("hasContext 在有文档路径且未移除时为 true", () => {
      const store = useAgentStore();
      const bridge = useEditorBridgeStore();
      bridge.activeDocPath = "/test/doc.md";
      expect(store.hasContext).toBe(true);
    });

    it("hasContext 在有文档路径但已移除时为 false", () => {
      const store = useAgentStore();
      const bridge = useEditorBridgeStore();
      bridge.activeDocPath = "/test/doc.md";
      store.removeContext();
      expect(store.hasContext).toBe(false);
    });

    it("contextDocPath 跟随 editor bridge 的 activeDocPath", () => {
      const store = useAgentStore();
      const bridge = useEditorBridgeStore();
      bridge.activeDocPath = "/path/to/file.md";
      expect(store.contextDocPath).toBe("/path/to/file.md");
      bridge.activeDocPath = "/another/path.md";
      expect(store.contextDocPath).toBe("/another/path.md");
    });
  });

  describe("markNewContentRead", () => {
    it("标记新内容已读后 hasNewContent 为 false", () => {
      const store = useAgentStore();
      store.setScrollPosition(false, true);
      store.markNewContentRead();
      expect(store.hasNewContent).toBe(false);
      expect(store.isAtBottom).toBe(true);
    });
  });
});
