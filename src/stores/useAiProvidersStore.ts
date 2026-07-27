import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { AiProvider, AiProviderPreset } from "../types";
import { AI_PROVIDER_PRESETS } from "../types";

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
   * 测试 provider 连接
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
    testConnection,
    resetTestStatus,
    getPresets,
  };
});
