import { ref, watch, type Ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { OutlineItem } from "../types";

/**
 * 大纲 composable
 * - 监听当前文件路径变化，自动拉取大纲
 * - 基于 Rust 端 mtime 缓存，避免重复解析
 */
export function useOutline(filePath: Ref<string | null>) {
  const outline = ref<OutlineItem[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchOutline(path: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const items = await invoke<OutlineItem[]>("parse_outline", { path });
      outline.value = items;
    } catch (err) {
      error.value = String(err);
      outline.value = [];
    } finally {
      loading.value = false;
    }
  }

  /**
   * 强制刷新大纲（文件保存后调用）
   */
  async function refresh(): Promise<void> {
    if (filePath.value) {
      // 先清除缓存，再重新拉取
      await invoke("invalidate_outline_cache", { path: filePath.value }).catch(
        () => {}
      );
      await fetchOutline(filePath.value);
    }
  }

  // 监听文件路径变化，自动拉取大纲
  watch(
    filePath,
    (newPath) => {
      if (newPath) {
        void fetchOutline(newPath);
      } else {
        outline.value = [];
      }
    },
    { immediate: true }
  );

  return {
    outline,
    loading,
    error,
    refresh,
  };
}
