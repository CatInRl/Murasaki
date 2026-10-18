import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { TreeListing, TreeNode } from "../types";
import { basename } from "../utils/path";
import { i18n } from "../i18n";
import {
  parseCommandError,
  formatCommandError,
  showRetryToast,
  type CommandErrorInfo,
} from "../utils/commandError";
import { usePersistenceStore } from "./usePersistenceStore";
import { useToastStore } from "./useToastStore";

/** 防重入锁：进行中的 refreshTree 调用 Promise（模块级，避免并发调用） */
let refreshPromise: Promise<void> | null = null;

/** 刷新文件树超时阈值（毫秒） */
const REFRESH_TIMEOUT_MS = 30000;

/**
 * 工作区 Store
 * - 管理当前工作区路径、文件树数据
 * - 提供打开文件夹、刷新文件树等操作
 * - 最近打开记录委托给 usePersistenceStore
 */
export const useWorkspaceStore = defineStore("workspace", () => {
  const persistence = usePersistenceStore();
  const toast = useToastStore();
  /** 文案翻译（用户可见文本必须走 i18n，禁止硬编码） */
  const t = i18n.global.t.bind(i18n.global);

  // ===== State =====
  /** 当前工作区根路径（null = 未打开工作区） */
  const workspacePath = ref<string | null>(null);
  /** 文件树数据 */
  const fileTree = ref<TreeNode[]>([]);
  /** 加载中标志 */
  const loading = ref(false);
  /** 最近一次读取文件树的失败（供文件树空态展示 ErrorState 与重试，#436） */
  const loadError = ref<CommandErrorInfo | null>(null);
  /** 当前选中的文件路径（用于高亮） */
  const selectedFilePath = ref<string | null>(null);
  /** 是否已就「文件树被截断」提示过（避免刷新/聚焦时反复弹窗，#432） */
  let truncatedNotified = false;

  /**
   * 读取文件树（带超时兜底）。
   * 后端已改为 `spawn_blocking`，不再阻塞主线程；超时只放弃等待，避免 loading 永久卡住。
   */
  async function listTree(path: string): Promise<TreeListing> {
    const treePromise = invoke<TreeListing>("list_tree", {
      path,
      showHidden: persistence.settings.showHiddenFiles,
    });
    // 与 Rust 侧同构的结构化错误，调用方统一按 code 判断
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject({ code: "timeout", params: { path } }),
        REFRESH_TIMEOUT_MS
      )
    );
    return Promise.race([treePromise, timeoutPromise]);
  }

  /** 应用一次文件树结果；截断时只提示一次，恢复正常后允许再次提示 */
  function applyListing(listing: TreeListing): void {
    fileTree.value = listing.nodes;
    loadError.value = null;
    if (!listing.truncated) {
      truncatedNotified = false;
      return;
    }
    if (truncatedNotified) return;
    truncatedNotified = true;
    toast.warning(t("editor.fileTree.truncated"), {
      description: t("editor.fileTree.truncatedDesc"),
    });
  }

  // ===== Getters =====
  const hasWorkspace = computed(() => workspacePath.value !== null);
  const workspaceName = computed(() => {
    if (!workspacePath.value) return "";
    return basename(workspacePath.value) || workspacePath.value;
  });

  // ===== Actions =====
  /**
   * 弹出系统对话框选择文件夹，并在**新窗口**中打开为工作区。
   *
   * 多工作区 = 多窗口（spec #194 决策 ②）：同一个文件夹已在某窗口打开时，
   * Rust 侧会聚焦那个窗口而不是重复开窗（避免同目录双 watcher 与文件操作冲突）。
   */
  async function openFolderDialog(): Promise<boolean> {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: t("common.openFolderTitle"),
    });
    if (typeof selected !== "string" || !selected) {
      return false;
    }
    try {
      await invoke("open_path_in_new_window", { path: selected });
    } catch (err) {
      console.error("新窗口打开文件夹失败:", err);
      toast.error(t("common.error.openWorkspaceFailed", { error: formatCommandError(err) }));
      return false;
    }
    return true;
  }

  /**
   * 打开指定路径作为工作区
   */
  async function openWorkspace(path: string): Promise<void> {
    loading.value = true;
    try {
      const listing = await listTree(path);
      workspacePath.value = path;
      // 新打开的工作区重新允许提示一次
      truncatedNotified = false;
      applyListing(listing);
      // 记录到最近打开（委托给 persistence store）
      await persistence.addRecent(path, "folder");
    } catch (err) {
      console.error("打开工作区失败:", err);
      loadError.value = parseCommandError(err);
      showRetryToast(
        t("common.error.openWorkspaceFailed", { error: formatCommandError(err) }),
        () => void openWorkspace(path).catch(() => {})
      );
      throw err;
    } finally {
      loading.value = false;
    }
  }

  /**
   * 刷新文件树（重新读取当前工作区）
   * - 防重入：进行中再次调用直接返回同一个 Promise
   * - 30s 超时兜底：避免大工作区/网络盘同步递归导致 loading 永久卡住
   */
  async function refreshTree(): Promise<void> {
    if (!workspacePath.value) return;
    const path = workspacePath.value;
    // 防重入：进行中直接返回同一个 Promise
    if (refreshPromise) return refreshPromise;

    loading.value = true;
    refreshPromise = (async () => {
      try {
        const listing = await listTree(path);
        // 读取期间换了工作区：丢弃本次结果，避免把旧树写到新工作区
        if (workspacePath.value === path) applyListing(listing);
      } catch (err) {
        const info = parseCommandError(err);
        loadError.value = info;
        if (info.code === "timeout") {
          console.error(`刷新文件树超时（${REFRESH_TIMEOUT_MS / 1000}s）`);
          toast.warning(t("editor.fileTree.refreshTimeout"), {
            description: t("editor.fileTree.refreshTimeoutDesc"),
            action: { label: t("common.retry"), onClick: () => void refreshTree() },
          });
        } else {
          console.error("刷新文件树失败:", err);
          // 树已渲染时保留旧树，仅用 toast 告知失败并给出重试入口
          showRetryToast(formatCommandError(err), () => void refreshTree());
        }
      } finally {
        loading.value = false;
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  /**
   * 关闭工作区
   */
  function closeWorkspace(): void {
    workspacePath.value = null;
    fileTree.value = [];
    selectedFilePath.value = null;
    loadError.value = null;
    truncatedNotified = false;
  }

  /**
   * 选中文件（用于高亮）
   */
  function selectFile(path: string | null): void {
    selectedFilePath.value = path;
  }

  return {
    // state
    workspacePath,
    fileTree,
    loading,
    loadError,
    selectedFilePath,
    // getters
    hasWorkspace,
    workspaceName,
    // actions
    openFolderDialog,
    openWorkspace,
    refreshTree,
    closeWorkspace,
    selectFile,
  };
});
