import { defineStore } from "pinia";
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  SearchProgressEvent,
  SearchResponse,
  SearchResult,
  SearchResultChunkEvent,
} from "../types";
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
 * 默认结果上限：避免超大工作区卡顿。
 * 与 Rust 端 DEFAULT_MAX_RESULTS 对齐（前端覆盖以保持 UI 行为一致）。
 */
export const DEFAULT_MAX_RESULTS = 1000;

/**
 * 生成一个唯一的 cancel_token（用于关联增量事件与具体搜索请求）
 * 不引入 uuid 依赖，组合 Date.now() + 随机串足够避免冲突
 */
function generateCancelToken(): string {
  return `search-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 跨文件搜索 Store
 * - 管理搜索查询、结果、选项与面板可见性
 * - 调用 Rust 端 `search_workspace` 命令执行搜索
 * - 通过 cancel_token + `cancel_search` 命令实现异步可取消
 * - 通过 `search-progress` / `search-result-chunk` 事件实现进度指示与增量返回
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

  // ===== 0.4.0 增量搜索状态 =====
  /** 当前搜索的 cancel_token（用于过滤过期事件 + 取消请求） */
  const cancelToken = ref<string | null>(null);
  /** 已扫描文件数 */
  const scannedFiles = ref(0);
  /** 待扫描文件总数 */
  const totalFiles = ref(0);
  /** 命中文件数 */
  const matchedFiles = ref(0);
  /** 命中行总数（仅内容命中） */
  const matchedCount = ref(0);
  /** 是否因达到上限而被截断 */
  const truncated = ref(false);

  // ===== 内部：事件监听器清理 =====
  let unlistenProgress: UnlistenFn | null = null;
  let unlistenChunk: UnlistenFn | null = null;

  /** 清理事件监听器 */
  function clearListeners(): void {
    if (unlistenProgress) {
      unlistenProgress();
      unlistenProgress = null;
    }
    if (unlistenChunk) {
      unlistenChunk();
      unlistenChunk = null;
    }
  }

  /** 重置增量搜索状态（不清理 results/filenameResults） */
  function resetProgressState(): void {
    scannedFiles.value = 0;
    totalFiles.value = 0;
    matchedFiles.value = 0;
    matchedCount.value = 0;
    truncated.value = false;
  }

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
   * 清空搜索查询与结果（不重置 options/visible）
   */
  function clear(): void {
    // 取消进行中的搜索
    void cancelSearch();
    clearListeners();
    query.value = "";
    results.value = [];
    filenameResults.value = [];
    resetProgressState();
    cancelToken.value = null;
  }

  /**
   * 请求取消当前进行中的搜索（若有）
   * 调用 Rust `cancel_search` 命令，由 Rust 端在下个扫描循环检查时退出
   */
  async function cancelSearch(): Promise<void> {
    const token = cancelToken.value;
    if (!token) return;
    try {
      await invoke("cancel_search", { cancelToken: token });
    } catch (err) {
      // 取消失败不影响后续流程
      console.warn("取消搜索失败:", err);
    }
  }

  /**
   * 执行跨文件搜索
   *
   * 流程（0.4.0 重构）：
   * 1. 若已有进行中的搜索：调用 `cancel_search` 中断（fire-and-forget）
   * 2. 清理旧监听器，重置增量状态
   * 3. 生成新 cancel_token，监听 `search-progress` 与 `search-result-chunk`
   *    （事件 payload 携带 cancelToken，过滤过期事件）
   * 4. 调用 `search_workspace` 传入 cancelToken + maxResults
   * 5. invoke 返回后用权威结果覆盖前端结果（保证一致），清理监听器
   */
  async function search(): Promise<SearchResponse> {
    const workspace = useWorkspaceStore();
    const workspacePath = workspace.workspacePath;
    const currentQuery = query.value.trim();

    // 无工作区或空查询：清空结果
    if (!workspacePath || !currentQuery) {
      // 取消进行中的搜索
      void cancelSearch();
      clearListeners();
      results.value = [];
      filenameResults.value = [];
      resetProgressState();
      cancelToken.value = null;
      return { contentResults: [], filenameResults: [], truncated: false };
    }

    // 中断旧搜索（fire-and-forget，避免阻塞新搜索启动）
    void cancelSearch();
    clearListeners();

    // 重置增量状态 + 准备新 token
    resetProgressState();
    results.value = [];
    filenameResults.value = [];
    const token = generateCancelToken();
    cancelToken.value = token;

    // 设置监听器（过滤过期 token 的事件）
    try {
      unlistenProgress = await listen<SearchProgressEvent>(
        "search-progress",
        (event) => {
          const payload = event.payload;
          if (!payload || payload.cancelToken !== token) return;
          scannedFiles.value = payload.scannedFiles;
          totalFiles.value = payload.totalFiles;
          matchedFiles.value = payload.matchedFiles;
          matchedCount.value = payload.matchedCount;
        }
      );
      unlistenChunk = await listen<SearchResultChunkEvent>(
        "search-result-chunk",
        (event) => {
          const payload = event.payload;
          if (!payload || payload.cancelToken !== token) return;
          if (payload.result) {
            // 增量追加内容命中
            results.value = [...results.value, payload.result];
          }
          if (payload.filenameMatch) {
            // 增量追加文件名命中（避免重复）
            if (!filenameResults.value.includes(payload.filenameMatch)) {
              filenameResults.value = [
                ...filenameResults.value,
                payload.filenameMatch,
              ];
            }
          }
        }
      );
    } catch (err) {
      console.warn("注册搜索事件监听失败，退化为最终结果一致模式:", err);
    }

    loading.value = true;
    try {
      const resp = await invoke<SearchResponse>("search_workspace", {
        workspace: workspacePath,
        query: currentQuery,
        options: options.value,
        cancelToken: token,
        maxResults: DEFAULT_MAX_RESULTS,
      });
      // 用权威结果覆盖（保证与 Rust 端最终状态一致，避免增量事件丢失/乱序）
      results.value = resp.contentResults;
      filenameResults.value = resp.filenameResults;
      truncated.value = resp.truncated;
      // 同步 matchedCount（若 Rust 端最终与增量累计不一致，以权威为准）
      const totalAuthoritative = resp.contentResults.reduce(
        (sum, r) => sum + r.matches.length,
        0
      );
      matchedCount.value = totalAuthoritative;
      matchedFiles.value = resp.contentResults.length;
      return resp;
    } catch (err) {
      console.error("跨文件搜索失败:", err);
      results.value = [];
      filenameResults.value = [];
      truncated.value = false;
      return { contentResults: [], filenameResults: [], truncated: false };
    } finally {
      loading.value = false;
      clearListeners();
      // 保留 cancelToken 直到下次搜索开始（便于 cancelSearch 幂等调用）
      // 不立即清空，避免错过最终 cancel 状态
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
    // 0.4.0 增量搜索状态
    cancelToken,
    scannedFiles,
    totalFiles,
    matchedFiles,
    matchedCount,
    truncated,
    // actions
    setQuery,
    setOptions,
    toggleVisible,
    clear,
    search,
    cancelSearch,
  };
});
