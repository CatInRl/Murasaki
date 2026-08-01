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

// ===== Mock fetch =====
const mockedFetch = vi.fn();
vi.stubGlobal("fetch", mockedFetch);

/** 构造 fetch Response mock */
function makeFetchResponse(opts: {
  ok: boolean;
  status: number;
  body?: unknown;
  bodyText?: string;
}): Response {
  const { ok, status, body, bodyText } = opts;
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body ?? {}),
    text: vi.fn().mockResolvedValue(bodyText ?? ""),
  } as unknown as Response;
}

beforeEach(() => {
  setActivePinia(createPinia());
  mockedInvoke.mockReset();
  mockedFetch.mockReset();
  localStorage.clear();
});

// ===== 测试用 provider 数据 =====
const TEST_PROVIDER: AiProvider = {
  id: "p1",
  name: "DeepSeek",
  type: "deepseek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  isActive: true,
};

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

    it("删除 provider 时同时清除 localStorage 测试结果", async () => {
      mockedInvoke.mockResolvedValueOnce(undefined);
      localStorage.setItem("test-result-p1", JSON.stringify({ success: true, message: "ok" }));

      const store = useAiProvidersStore();
      store.providers = [TEST_PROVIDER];
      await store.deleteProvider("p1");

      expect(localStorage.getItem("test-result-p1")).toBeNull();
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

  describe("testProvider", () => {
    it("provider 不存在时返回失败结果，不调用 fetch", async () => {
      const store = useAiProvidersStore();
      const result = await store.testProvider("nonexistent");

      expect(result.success).toBe(false);
      expect(result.message).toContain("Provider 不存在");
      expect(mockedFetch).not.toHaveBeenCalled();
    });

    it("成功时返回 success: true 并持久化到 localStorage", async () => {
      mockedInvoke.mockResolvedValueOnce("sk-test-key");
      mockedFetch.mockResolvedValueOnce(
        makeFetchResponse({
          ok: true,
          status: 200,
          body: { data: [{ id: "model-a" }, { id: "model-b" }] },
        })
      );

      const store = useAiProvidersStore();
      store.providers = [TEST_PROVIDER];
      const result = await store.testProvider("p1");

      expect(result.success).toBe(true);
      expect(result.message).toContain("2 个模型");

      // 验证 localStorage 持久化
      const stored = localStorage.getItem("test-result-p1");
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored!);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain("2 个模型");
      expect(typeof parsed.timestamp).toBe("number");
    });

    it("成功但响应无模型列表时消息为'连接成功'", async () => {
      mockedInvoke.mockResolvedValueOnce("sk-test-key");
      mockedFetch.mockResolvedValueOnce(
        makeFetchResponse({
          ok: true,
          status: 200,
          body: {},
        })
      );

      const store = useAiProvidersStore();
      store.providers = [TEST_PROVIDER];
      const result = await store.testProvider("p1");

      expect(result.success).toBe(true);
      expect(result.message).toBe("连接成功");
    });

    it("成功但响应体非 JSON 时仍返回成功", async () => {
      mockedInvoke.mockResolvedValueOnce("sk-test-key");
      const response = makeFetchResponse({ ok: true, status: 200 });
      // json() 抛出异常
      (response.json as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new SyntaxError("Unexpected token")
      );
      mockedFetch.mockResolvedValueOnce(response);

      const store = useAiProvidersStore();
      store.providers = [TEST_PROVIDER];
      const result = await store.testProvider("p1");

      expect(result.success).toBe(true);
      expect(result.message).toBe("连接成功");
    });

    it("HTTP 错误时返回 success: false 并持久化", async () => {
      mockedInvoke.mockResolvedValueOnce("sk-test-key");
      mockedFetch.mockResolvedValueOnce(
        makeFetchResponse({
          ok: false,
          status: 401,
          bodyText: "Unauthorized",
        })
      );

      const store = useAiProvidersStore();
      store.providers = [TEST_PROVIDER];
      const result = await store.testProvider("p1");

      expect(result.success).toBe(false);
      expect(result.message).toContain("HTTP 401");
      expect(result.message).toContain("Unauthorized");

      const stored = localStorage.getItem("test-result-p1");
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored!);
      expect(parsed.success).toBe(false);
    });

    it("网络错误时返回 success: false 并持久化", async () => {
      mockedInvoke.mockResolvedValueOnce("sk-test-key");
      mockedFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      const store = useAiProvidersStore();
      store.providers = [TEST_PROVIDER];
      const result = await store.testProvider("p1");

      expect(result.success).toBe(false);
      expect(result.message).toContain("Failed to fetch");

      const stored = localStorage.getItem("test-result-p1");
      expect(stored).not.toBeNull();
    });

    it("无法获取 API Key 时返回失败结果并持久化", async () => {
      mockedInvoke.mockRejectedValueOnce(new Error("Provider 未配置 API key"));

      const store = useAiProvidersStore();
      store.providers = [TEST_PROVIDER];
      const result = await store.testProvider("p1");

      expect(result.success).toBe(false);
      expect(result.message).toContain("无法获取 API Key");
      expect(mockedFetch).not.toHaveBeenCalled();

      const stored = localStorage.getItem("test-result-p1");
      expect(stored).not.toBeNull();
    });

    it("更新 testStatus 和 testMessage 状态", async () => {
      mockedInvoke.mockResolvedValueOnce("sk-test-key");
      mockedFetch.mockResolvedValueOnce(
        makeFetchResponse({ ok: true, status: 200, body: { data: [] } })
      );

      const store = useAiProvidersStore();
      store.providers = [TEST_PROVIDER];
      await store.testProvider("p1");

      expect(store.testStatus).toBe("success");
      expect(store.testMessage).toContain("连接成功");
    });

    it("失败时更新 testStatus 为 error", async () => {
      mockedInvoke.mockResolvedValueOnce("sk-test-key");
      mockedFetch.mockRejectedValueOnce(new Error("Network error"));

      const store = useAiProvidersStore();
      store.providers = [TEST_PROVIDER];
      await store.testProvider("p1");

      expect(store.testStatus).toBe("error");
    });

    it("URL 拼接正确：baseUrl + /v1/models", async () => {
      mockedInvoke.mockResolvedValueOnce("sk-test-key");
      mockedFetch.mockResolvedValueOnce(
        makeFetchResponse({ ok: true, status: 200, body: {} })
      );

      const store = useAiProvidersStore();
      store.providers = [TEST_PROVIDER];
      await store.testProvider("p1");

      expect(mockedFetch).toHaveBeenCalledWith(
        "https://api.deepseek.com/v1/models",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("URL 去掉尾部斜杠后拼接", async () => {
      mockedInvoke.mockResolvedValueOnce("sk-test-key");
      mockedFetch.mockResolvedValueOnce(
        makeFetchResponse({ ok: true, status: 200, body: {} })
      );

      const store = useAiProvidersStore();
      store.providers = [
        { ...TEST_PROVIDER, baseUrl: "https://api.deepseek.com/" },
      ];
      await store.testProvider("p1");

      expect(mockedFetch).toHaveBeenCalledWith(
        "https://api.deepseek.com/v1/models",
        expect.any(Object)
      );
    });

    it("Authorization header 携带 Bearer API Key", async () => {
      mockedInvoke.mockResolvedValueOnce("sk-secret-key");
      mockedFetch.mockResolvedValueOnce(
        makeFetchResponse({ ok: true, status: 200, body: {} })
      );

      const store = useAiProvidersStore();
      store.providers = [TEST_PROVIDER];
      await store.testProvider("p1");

      expect(mockedFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: { Authorization: "Bearer sk-secret-key" },
        })
      );
    });

    it("不抛出异常（所有错误以返回值传递）", async () => {
      mockedInvoke.mockResolvedValueOnce("sk-test-key");
      mockedFetch.mockRejectedValueOnce(new Error("网络断开"));

      const store = useAiProvidersStore();
      store.providers = [TEST_PROVIDER];

      // 不应抛出
      const result = await store.testProvider("p1");
      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });
  });

  describe("getTestResult", () => {
    it("无存储结果时返回 null", () => {
      const store = useAiProvidersStore();
      expect(store.getTestResult("p1")).toBeNull();
    });

    it("有存储结果时返回解析后的结果", () => {
      localStorage.setItem(
        "test-result-p1",
        JSON.stringify({
          success: true,
          message: "连接成功",
          timestamp: Date.now(),
        })
      );

      const store = useAiProvidersStore();
      const result = store.getTestResult("p1");

      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      expect(result!.message).toBe("连接成功");
    });

    it("损坏的 JSON 返回 null", () => {
      localStorage.setItem("test-result-p1", "{ invalid json");

      const store = useAiProvidersStore();
      expect(store.getTestResult("p1")).toBeNull();
    });
  });

  describe("clearTestResult", () => {
    it("清除 localStorage 中的测试结果", () => {
      localStorage.setItem(
        "test-result-p1",
        JSON.stringify({ success: true, message: "ok" })
      );

      const store = useAiProvidersStore();
      store.clearTestResult("p1");

      expect(localStorage.getItem("test-result-p1")).toBeNull();
    });

    it("清除不存在的 key 不报错", () => {
      const store = useAiProvidersStore();
      expect(() => store.clearTestResult("nonexistent")).not.toThrow();
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
    it("返回预设列表（含 DeepSeek / OpenAI / Anthropic / 自定义）", () => {
      const store = useAiProvidersStore();
      const presets = store.getPresets();

      expect(presets).toHaveLength(4);
      expect(presets.map((p) => p.type)).toEqual([
        "deepseek",
        "openai",
        "anthropic",
        "custom",
      ]);
    });

    it("DeepSeek 预设内容正确", () => {
      const store = useAiProvidersStore();
      const presets = store.getPresets();
      const deepseek = presets.find((p) => p.type === "deepseek");

      expect(deepseek).toBeDefined();
      expect(deepseek?.label).toBe("DeepSeek");
      expect(deepseek?.baseUrl).toBe("https://api.deepseek.com");
      expect(deepseek?.model).toBe("deepseek-v4-flash");
    });

    it("OpenAI 预设内容正确", () => {
      const store = useAiProvidersStore();
      const presets = store.getPresets();
      const openai = presets.find((p) => p.type === "openai");

      expect(openai).toBeDefined();
      expect(openai?.label).toBe("OpenAI");
      expect(openai?.baseUrl).toBe("https://api.openai.com");
      expect(openai?.model).toBe("gpt-4o-mini");
    });

    it("自定义预设 baseUrl 与 model 为空", () => {
      const store = useAiProvidersStore();
      const presets = store.getPresets();
      const custom = presets.find((p) => p.type === "custom");

      expect(custom).toBeDefined();
      expect(custom?.label).toBe("自定义");
      expect(custom?.baseUrl).toBe("");
      expect(custom?.model).toBe("");
    });
  });
});
