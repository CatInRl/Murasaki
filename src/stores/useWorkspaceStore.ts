import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { TreeNode } from "../types";
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

  // ===== State =====
  /** 当前工作区根路径（null = 未打开工作区） */
  const workspacePath = ref<string | null>(null);
  /** 文件树数据 */
  const fileTree = ref<TreeNode[]>([]);
  /** 加载中标志 */
  const loading = ref(false);
  /** 当前选中的文件路径（用于高亮） */
  const selectedFilePath = ref<string | null>(null);

  // ===== Getters =====
  const hasWorkspace = computed(() => workspacePath.value !== null);
  const workspaceName = computed(() => {
    if (!workspacePath.value) return "";
    const parts = workspacePath.value.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] ?? workspacePath.value;
  });

  // ===== Actions =====
  /**
   * 弹出系统对话框选择文件夹，并加载文件树
   */
  async function openFolderDialog(): Promise<boolean> {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "选择工作区文件夹",
    });
    if (typeof selected !== "string" || !selected) {
      return false;
    }
    await openWorkspace(selected);
    return true;
  }

  /**
   * 打开指定路径作为工作区
   */
  async function openWorkspace(path: string): Promise<void> {
    loading.value = true;
    try {
      const tree = await invoke<TreeNode[]>("list_tree", {
        path,
        showHidden: persistence.settings.showHiddenFiles,
      });
      workspacePath.value = path;
      fileTree.value = tree;
      // 记录到最近打开（委托给 persistence store）
      await persistence.addRecent(path, "folder");
    } catch (err) {
      console.error("打开工作区失败:", err);
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
    // 防重入：进行中直接返回同一个 Promise
    if (refreshPromise) return refreshPromise;

    loading.value = true;
    refreshPromise = (async () => {
      try {
        const treePromise = invoke<TreeNode[]>("list_tree", {
          path: workspacePath.value,
          showHidden: persistence.settings.showHiddenFiles,
        });
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), REFRESH_TIMEOUT_MS)
        );
        const tree = await Promise.race([treePromise, timeoutPromise]);
        fileTree.value = tree;
      } catch (err) {
        if (err instanceof Error && err.message === "timeout") {
          console.error(`刷新文件树超时（${REFRESH_TIMEOUT_MS / 1000}s）`);
          toast.warning("刷新超时", {
            description: "可能是工作区过大或网络盘响应慢",
          });
        } else {
          console.error("刷新文件树失败:", err);
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
