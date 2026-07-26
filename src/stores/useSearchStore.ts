import { defineStore } from "pinia";
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { SearchResponse, SearchResult } from "../types";
import { useWorkspaceStore } from "./useWorkspaceStore";

/**
 * 搜索选项
 */
export interface SearchOptions {
  /** 启用正则表达式匹配 */
  regex: boolean;
  /** 区分大小写 */
  caseSensitive: boolean;
  /** 全词匹配 */
  wholeWord: boolean;
}

/**
 * 跨文件搜索 Store
 * - 管理搜索查询、结果、选项与面板可见性
 * - 调用 Rust 端 `search_workspace` 命令执行搜索
 * - 分别存储内容匹配与文件名匹配
 */
export const useSearchStore = defineStore("search", () => {
  // ===== State =====
  /** 搜索关键词 */
  const query = ref("");
  /** 内容匹配结果 */
  const results = ref<SearchResult[]>([]);
  /** 文件名匹配结果（仅路径字符串） */
  const filenameResults = ref<string[]>([]);
  /** 加载中标志 */
  const loading = ref(false);
  /** 搜索选项 */
  const options = ref<SearchOptions>({
    regex: false,
    caseSensitive: false,
    wholeWord: false,
  });
  /** 面板可见性 */
  const visible = ref(false);

  // ===== Actions =====
  /**
   * 设置搜索关键词
   */
  function setQuery(value: string): void {
    query.value = value;
  }

  /**
   * 更新搜索选项（部分合并）
   */
  function setOptions(patch: Partial<SearchOptions>): void {
    options.value = { ...options.value, ...patch };
  }

  /**
   * 切换面板显隐
   */
  function toggleVisible(): void {
    visible.value = !visible.value;
  }

  /**
   * 清空搜索查询与结果
   */
  function clear(): void {
    query.value = "";
    results.value = [];
    filenameResults.value = [];
  }

  /**
   * 执行跨文件搜索
   * 调用 Rust 端 `search_workspace` 命令，同时获取内容与文件名匹配
   * 失败时 console.error 并清空结果
   */
  async function search(): Promise<SearchResponse> {
    const workspace = useWorkspaceStore();
    const workspacePath = workspace.workspacePath;
    const currentQuery = query.value.trim();

    // 无工作区或空查询：清空结果
    if (!workspacePath || !currentQuery) {
      results.value = [];
      filenameResults.value = [];
      return { contentResults: [], filenameResults: [] };
    }

    loading.value = true;
    try {
      const resp = await invoke<SearchResponse>("search_workspace", {
        workspace: workspacePath,
        query: currentQuery,
        options: options.value,
      });
      results.value = resp.contentResults;
      filenameResults.value = resp.filenameResults;
      return resp;
    } catch (err) {
      console.error("跨文件搜索失败:", err);
      results.value = [];
      filenameResults.value = [];
      return { contentResults: [], filenameResults: [] };
    } finally {
      loading.value = false;
    }
  }

  return {
    // state
    query,
    results,
    filenameResults,
    loading,
    options,
    visible,
    // actions
    setQuery,
    setOptions,
    toggleVisible,
    clear,
    search,
  };
});
