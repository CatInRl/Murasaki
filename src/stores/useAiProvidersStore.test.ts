import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useAiProvidersStore } from "./useAiProvidersStore";
import type { AiProvider } from "../types";

// ===== Mock @tauri-apps/api/core 的 invoke =====
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";

const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  setActivePinia(createPinia());
  mockedInvoke.mockReset();
});

describe("useAiProvidersStore", () => {
  describe("初始状态", () => {
    it("providers 为空数组", () => {
      const store = useAiProvidersStore();
      expect(store.providers).toEqual([]);
    });

    it("loaded 为 false", () => {
      const store = useAiProvidersStore();
      expect(store.loaded).toBe(false);
    });

    it("activeProvider 为 null（无 provider）", () => {
      const store = useAiProvidersStore();
      expect(store.activeProvider).toBeNull();
    });

    it("hasProvider 为 false", () => {
      const store = useAiProvidersStore();
      expect(store.hasProvider).toBe(false);
    });

    it("testStatus 为 idle", () => {
      const store = useAiProvidersStore();
      expect(store.testStatus).toBe("idle");
    });
  });

  describe("load", () => {
    it("调用 get_ai_providers 命令加载 providers", async () => {
      const fakeProviders: AiProvider[] = [
        {
          id: "p1",
          name: "DeepSeek",
          type: "deepseek",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-v4-flash",
          isActive: true,
        },
      ];
      mockedInvoke.mockResolvedValueOnce(fakeProviders);

      const store = useAiProvidersStore();
      await store.load();

      expect(mockedInvoke).toHaveBeenCalledWith("get_ai_providers");
      expect(store.providers).toEqual(fakeProviders);
      expect(store.loaded).toBe(true);
    });

    it("加载失败时 providers 为空且 loaded 为 true", async () => {
      mockedInvoke.mockRejectedValueOnce(new Error("文件不存在"));

      const store = useAiProvidersStore();
      await store.load();

      expect(store.providers).toEqual([]);
      expect(store.loaded).toBe(true);
    });
  });

  describe("saveProvider", () => {
    it("新增 provider 时调用 save_ai_provider 命令", async () => {
      const newProvider: AiProvider = {
        id: "",
        name: "DeepSeek",
        type: "deepseek",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        isActive: true,
      };
      const savedProvider: AiProvider = {
        ...newProvider,
        id: "generated-uuid",
      };
      mockedInvoke.mockResolvedValueOnce(savedProvider);

      const store = useAiProvidersStore();
      const result = await store.saveProvider(newProvider, "sk-test-key");

      expect(mockedInvoke).toHaveBeenCalledWith("save_ai_provider", {
        provider: expect.objectContaining({
          id: "",
          name: "DeepSeek",
          apiKeyEnc: "",
          isActive: true,
        }),
        apiKey: "sk-test-key",
      });
      expect(result).toEqual(savedProvider);
      expect(store.providers).toContainEqual(savedProvider);
    });

    it("更新已有 provider 时替换原条目", async () => {
      const existing: AiProvider = {
        id: "p1",
        name: "Old Name",
        type: "deepseek",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        isActive: true,
      };
      const updated: AiProvider = {
        ...existing,
        name: "New Name",
      };
      mockedInvoke.mockResolvedValueOnce(updated);

      const store = useAiProvidersStore();
      store.providers = [existing];
      await store.saveProvider(updated, "");

      expect(store.providers).toHaveLength(1);
      expect(store.providers[0].name).toBe("New Name");
    });

    it("设为活动时其他 provider 的 isActive 置为 false", async () => {
      const p1: AiProvider = {
        id: "p1",
        name: "P1",
        type: "deepseek",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        isActive: true,
      };
      const p2: AiProvider = {
        id: "p2",
        name: "P2",
        type: "openai",
        baseUrl: "https://api.openai.com",
        model: "gpt-4o-mini",
        isActive: false,
      };
      const savedP2: AiProvider = { ...p2, isActive: true };
      mockedInvoke.mockResolvedValueOnce(savedP2);

      const store = useAiProvidersStore();
      store.providers = [p1, p2];
      await store.saveProvider({ ...p2, isActive: true }, "sk-new-key");

      expect(store.providers.find((p) => p.id === "p1")?.isActive).toBe(false);
      expect(store.providers.find((p) => p.id === "p2")?.isActive).toBe(true);
    });
  });

  describe("deleteProvider", () => {
    it("调用 delete_ai_provider 命令并从列表移除", async () => {
      const p1: AiProvider = {
        id: "p1",
        name: "P1",
        type: "deepseek",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        isActive: true,
      };
      mockedInvoke.mockResolvedValueOnce(undefined);

      const store = useAiProvidersStore();
      store.providers = [p1];
      await store.deleteProvider("p1");

      expect(mockedInvoke).toHaveBeenCalledWith("delete_ai_provider", {
        id: "p1",
      });
      expect(store.providers).toEqual([]);
    });
  });

  describe("setActive", () => {
    it("调用 set_active_provider 命令并更新本地状态", async () => {
      const p1: AiProvider = {
        id: "p1",
        name: "P1",
        type: "deepseek",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        isActive: false,
      };
      const p2: AiProvider = {
        id: "p2",
        name: "P2",
        type: "openai",
        baseUrl: "https://api.openai.com",
        model: "gpt-4o-mini",
        isActive: true,
      };
      mockedInvoke.mockResolvedValueOnce(undefined);

      const store = useAiProvidersStore();
      store.providers = [p1, p2];
      await store.setActive("p1");

      expect(mockedInvoke).toHaveBeenCalledWith("set_active_provider", {
        id: "p1",
      });
      expect(store.providers.find((p) => p.id === "p1")?.isActive).toBe(true);
      expect(store.providers.find((p) => p.id === "p2")?.isActive).toBe(false);
    });
  });

  describe("getApiKey", () => {
    it("调用 get_api_key 命令返回明文 key", async () => {
      mockedInvoke.mockResolvedValueOnce("sk-plaintext-key");

      const store = useAiProvidersStore();
      const key = await store.getApiKey("p1");

      expect(mockedInvoke).toHaveBeenCalledWith("get_api_key", { id: "p1" });
      expect(key).toBe("sk-plaintext-key");
    });
  });

  describe("testConnection", () => {
    it("成功时更新 testStatus 为 success", async () => {
      const models = ["deepseek-chat", "deepseek-reasoner"];
      mockedInvoke.mockResolvedValueOnce(models);

      const store = useAiProvidersStore();
      const result = await store.testConnection(
        "https://api.deepseek.com",
        "sk-test",
        "deepseek-v4-flash"
      );

      expect(mockedInvoke).toHaveBeenCalledWith("test_provider_connection", {
        baseUrl: "https://api.deepseek.com",
        apiKey: "sk-test",
        model: "deepseek-v4-flash",
      });
      expect(result).toEqual(models);
      expect(store.testStatus).toBe("success");
      expect(store.testModels).toEqual(models);
      expect(store.testMessage).toContain("2 个模型");
    });

    it("fallback 成功时 testModels 为空", async () => {
      mockedInvoke.mockResolvedValueOnce([]);

      const store = useAiProvidersStore();
      await store.testConnection("https://api.deepseek.com", "sk-test", "deepseek-v4-flash");

      expect(store.testStatus).toBe("success");
      expect(store.testModels).toEqual([]);
      expect(store.testMessage).toContain("fallback");
    });

    it("失败时更新 testStatus 为 error 并抛出", async () => {
      mockedInvoke.mockRejectedValueOnce(new Error("HTTP 401"));

      const store = useAiProvidersStore();
      await expect(
        store.testConnection("https://api.deepseek.com", "sk-wrong", "deepseek-v4-flash")
      ).rejects.toThrow();

      expect(store.testStatus).toBe("error");
      expect(store.testMessage).toContain("HTTP 401");
    });
  });

  describe("resetTestStatus", () => {
    it("重置 testStatus 为 idle", async () => {
      const store = useAiProvidersStore();
      store.testStatus = "success";
      store.testMessage = "成功";
      store.testModels = ["m1"];

      store.resetTestStatus();

      expect(store.testStatus).toBe("idle");
      expect(store.testMessage).toBe("");
      expect(store.testModels).toEqual([]);
    });
  });

  describe("activeProvider computed", () => {
    it("返回 isActive 为 true 的 provider", () => {
      const p1: AiProvider = {
        id: "p1",
        name: "P1",
        type: "deepseek",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        isActive: false,
      };
      const p2: AiProvider = {
        id: "p2",
        name: "P2",
        type: "openai",
        baseUrl: "https://api.openai.com",
        model: "gpt-4o-mini",
        isActive: true,
      };

      const store = useAiProvidersStore();
      store.providers = [p1, p2];

      expect(store.activeProvider).toEqual(p2);
    });

    it("无活动 provider 时返回 null", () => {
      const store = useAiProvidersStore();
      store.providers = [
        {
          id: "p1",
          name: "P1",
          type: "deepseek",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-v4-flash",
          isActive: false,
        },
      ];

      expect(store.activeProvider).toBeNull();
    });
  });

  describe("getPresets", () => {
    it("返回预设列表（含 DeepSeek / OpenAI / 自定义）", () => {
      const store = useAiProvidersStore();
      const presets = store.getPresets();

      expect(presets).toHaveLength(3);
      expect(presets.map((p) => p.type)).toEqual([
        "deepseek",
        "openai",
        "custom",
      ]);
    });
  });
});
