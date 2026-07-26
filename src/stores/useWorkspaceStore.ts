import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { TreeNode } from "../types";
import { usePersistenceStore } from "./usePersistenceStore";

/**
 * 工作区 Store
 * - 管理当前工作区路径、文件树数据
 * - 提供打开文件夹、刷新文件树等操作
 * - 最近打开记录委托给 usePersistenceStore
 */
export const useWorkspaceStore = defineStore("workspace", () => {
  const persistence = usePersistenceStore();

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
   */
  async function refreshTree(): Promise<void> {
    if (!workspacePath.value) return;
    loading.value = true;
    try {
      const tree = await invoke<TreeNode[]>("list_tree", {
        path: workspacePath.value,
        showHidden: persistence.settings.showHiddenFiles,
      });
      fileTree.value = tree;
    } catch (err) {
      console.error("刷新文件树失败:", err);
      throw err;
    } finally {
      loading.value = false;
    }
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
