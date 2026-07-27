import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useAgentStore } from "./useAgentStore";
import { useWorkspaceStore } from "./useWorkspaceStore";

// Mock Tauri invoke
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// Mock OpenAICompatibleProvider
vi.mock("../agent/OpenAICompatibleProvider", () => ({
  OpenAICompatibleProvider: vi.fn().mockImplementation(() => ({
    streamChat: vi.fn(),
  })),
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
});
