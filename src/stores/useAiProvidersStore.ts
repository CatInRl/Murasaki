import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { AiProvider, AiProviderPreset } from "../types";
import { AI_PROVIDER_PRESETS } from "../types";

/**
 * 测试连接结果（T8.4）
 */
export interface TestConnectionResult {
  success: boolean;
  message?: string;
}

/** localStorage key 前缀：test-result-{providerId} */
const TEST_RESULT_KEY_PREFIX = "test-result-";

function testResultKey(id: string): string {
  return `${TEST_RESULT_KEY_PREFIX}${id}`;
}

/** 将测试结果持久化到 localStorage */
function saveTestResult(id: string, result: TestConnectionResult): void {
  try {
    localStorage.setItem(
      testResultKey(id),
      JSON.stringify({ ...result, timestamp: Date.now() })
    );
  } catch {
    // localStorage 不可用时静默失败
  }
}

/** 读取 localStorage 中的上次测试结果 */
function readTestResult(id: string): TestConnectionResult | null {
  try {
    const raw = localStorage.getItem(testResultKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      success: Boolean(parsed.success),
      message: typeof parsed.message === "string" ? parsed.message : undefined,
    };
  } catch {
    return null;
  }
}

/** 清除 localStorage 中的测试结果（删除 provider 时调用） */
function removeTestResult(id: string): void {
  try {
    localStorage.removeItem(testResultKey(id));
  } catch {
    // 静默失败
  }
}

/**
 * AI Provider 配置 Store
 *
 * 管理 LLM provider 列表与活动 provider。
 * API key 通过 Windows DPAPI 加密存储在 %APPDATA%\murasaki\secrets.json，
 * 明文不在前端持久化 —— 调用 getApiKey 按需获取（用完丢弃，不缓存）。
 */
export const useAiProvidersStore = defineStore("aiProviders", () => {
  // ===== State =====
  const providers = ref<AiProvider[]>([]);
  /** 是否已完成首次加载 */
  const loaded = ref(false);
  /** 测试连接状态：'idle' | 'testing' | 'success' | 'error' */
  const testStatus = ref<"idle" | "testing" | "success" | "error">("idle");
  /** 测试连接返回的消息（成功时为模型列表，失败时为错误信息） */
  const testMessage = ref<string>("");
  /** 测试连接成功时返回的模型列表 */
  const testModels = ref<string[]>([]);

  // ===== Computed =====
  /** 当前活动 provider（无则 null） */
  const activeProvider = computed<AiProvider | null>(
    () => providers.value.find((p) => p.isActive) ?? null
  );

  /** 是否已配置任何 provider */
  const hasProvider = computed(() => providers.value.length > 0);

  // ===== Actions =====

  /** 从磁盘加载 provider 列表（首次调用） */
  async function load(): Promise<void> {
    try {
      providers.value = await invoke<AiProvider[]>("get_ai_providers");
      loaded.value = true;
    } catch (err) {
      console.error("加载 AI providers 失败:", err);
      providers.value = [];
      loaded.value = true;
    }
  }

  /**
   * 新增或更新 provider
   * @param provider provider 配置（id 为空表示新增）
   * @param apiKey API key 明文（新增时必填，更新时为空表示保留原 key）
   */
  async function saveProvider(
    provider: AiProvider,
    apiKey: string
  ): Promise<AiProvider> {
    // 调用 Rust 命令时需要传递完整的 provider 结构（含 apiKeyEnc 字段，前端传空字符串）
    // Rust 侧会读取该字段名，但实际加密后的密文由 Rust 写入磁盘
    const result = await invoke<AiProvider>("save_ai_provider", {
      provider: {
        id: provider.id,
        name: provider.name,
        type: provider.type,
        baseUrl: provider.baseUrl,
        model: provider.model,
        apiKeyEnc: "", // Rust 侧忽略此字段（使用 api_key 参数加密）
        isActive: provider.isActive,
      },
      apiKey,
    });
    // upsert 到本地状态
    const idx = providers.value.findIndex((p) => p.id === result.id);
    if (idx >= 0) {
      providers.value[idx] = result;
    } else {
      providers.value.push(result);
    }
    // 若 result 被设为活动，更新其他 provider 的 isActive
    if (result.isActive) {
      for (const p of providers.value) {
        if (p.id !== result.id) p.isActive = false;
      }
    }
    return result;
  }

  /** 删除 provider */
  async function deleteProvider(id: string): Promise<void> {
    await invoke("delete_ai_provider", { id });
    providers.value = providers.value.filter((p) => p.id !== id);
    removeTestResult(id);
  }

  /** 设置活动 provider */
  async function setActive(id: string): Promise<void> {
    await invoke("set_active_provider", { id });
    for (const p of providers.value) {
      p.isActive = p.id === id;
    }
  }

  /**
   * 获取明文 API key（每次对话调用，不缓存）
   * 调用方应在使用后立即丢弃，不要存储在 Vue 响应式状态
   */
  async function getApiKey(id: string): Promise<string> {
    return invoke<string>("get_api_key", { id });
  }

  /**
   * 测试 provider 连接（T8.4）
   *
   * 通过 provider id 查找配置，从后端获取 API key，
   * 向 {baseUrl}/v1/models 发 GET 请求验证连通性。
   * 结果持久化到 localStorage（key: test-result-{id}）。
   *
   * 不抛出异常 —— 所有错误以 { success: false, message } 返回。
   */
  async function testProvider(id: string): Promise<TestConnectionResult> {
    const provider = providers.value.find((p) => p.id === id);
    if (!provider) {
      return { success: false, message: "Provider 不存在" };
    }

    testStatus.value = "testing";
    testMessage.value = "测试中…";

    // 从后端获取明文 API key
    let apiKey: string;
    try {
      apiKey = await getApiKey(id);
    } catch (err) {
      const message = `无法获取 API Key: ${String(err)}`;
      const result: TestConnectionResult = { success: false, message };
      testStatus.value = "error";
      testMessage.value = message;
      saveTestResult(id, result);
      return result;
    }

    // 规范化 URL：去掉尾部斜杠后拼接 /v1/models
    const base = provider.baseUrl.replace(/\/+$/, "");
    const url = `${base}/v1/models`;

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      if (response.ok) {
        // 尝试解析模型列表（解析失败不影响成功判定）
        let modelCount = 0;
        try {
          const body = await response.json();
          if (body && Array.isArray(body.data)) {
            modelCount = body.data.length;
          }
        } catch {
          // 响应体非 JSON 或无法解析，连通性已验证
        }
        const message =
          modelCount > 0
            ? `连接成功，发现 ${modelCount} 个模型`
            : "连接成功";
        const result: TestConnectionResult = { success: true, message };
        testStatus.value = "success";
        testMessage.value = message;
        saveTestResult(id, result);
        return result;
      }

      // HTTP 错误响应
      let errText = "";
      try {
        errText = await response.text();
      } catch {
        // 忽略 body 读取失败
      }
      const message = `HTTP ${response.status}${errText ? `: ${errText}` : ""}`;
      const result: TestConnectionResult = { success: false, message };
      testStatus.value = "error";
      testMessage.value = message;
      saveTestResult(id, result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result: TestConnectionResult = { success: false, message };
      testStatus.value = "error";
      testMessage.value = message;
      saveTestResult(id, result);
      return result;
    }
  }

  /** 读取 localStorage 中的上次测试结果 */
  function getTestResult(id: string): TestConnectionResult | null {
    return readTestResult(id);
  }

  /** 清除指定 provider 的测试结果 */
  function clearTestResult(id: string): void {
    removeTestResult(id);
  }

  /**
   * 测试 provider 连接（底层方法，通过 Tauri 后端发请求）
   * 先 GET /models，失败 fallback 1-token chat
   * @returns 成功时返回模型列表（可能为空数组，表示 fallback 成功）
   */
  async function testConnection(
    baseUrl: string,
    apiKey: string,
    model: string
  ): Promise<string[]> {
    testStatus.value = "testing";
    testMessage.value = "";
    testModels.value = [];
    try {
      const models = await invoke<string[]>("test_provider_connection", {
        baseUrl,
        apiKey,
        model,
      });
      testStatus.value = "success";
      testModels.value = models;
      testMessage.value =
        models.length > 0
          ? `连接成功，发现 ${models.length} 个模型`
          : "连接成功（fallback 验证）";
      return models;
    } catch (err) {
      testStatus.value = "error";
      testMessage.value = String(err);
      throw err;
    }
  }

  /** 重置测试状态 */
  function resetTestStatus(): void {
    testStatus.value = "idle";
    testMessage.value = "";
    testModels.value = [];
  }

  /** 获取预设列表 */
  function getPresets(): AiProviderPreset[] {
    return AI_PROVIDER_PRESETS;
  }

  return {
    // state
    providers,
    loaded,
    testStatus,
    testMessage,
    testModels,
    // computed
    activeProvider,
    hasProvider,
    // actions
    load,
    saveProvider,
    deleteProvider,
    setActive,
    getApiKey,
    testProvider,
    getTestResult,
    clearTestResult,
    testConnection,
    resetTestStatus,
    getPresets,
  };
});
