import { ref, watch, type Ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { OutlineItem } from "../types";

/**
 * 大纲 composable
 * - 监听当前文件路径变化，自动拉取大纲
 * - 基于 Rust 端 mtime 缓存，避免重复解析
 */
export function useOutline(
  filePath: Ref<string | null>,
  content: Ref<string> | null = null,
  enabled: Ref<boolean> | (() => boolean) = () => true,
) {
  const isLiveEnabled = typeof enabled === "function" ? enabled : () => enabled.value;
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

  // 监听文件路径变化，自动拉取磁盘权威大纲
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

  // ===== 编辑态实时刷新（issue #170）=====
  // 变更事件 → 200ms 防抖 → 调 parse_outline_str（单一解析源，无磁盘/mtime）
  // 用自增序列号丢弃过期返回，避免异步乱序回跳
  const LIVE_DEBOUNCE_MS = 200;
  let liveTimer: ReturnType<typeof setTimeout> | null = null;
  let liveSeq = 0;

  async function updateLiveText(text: string): Promise<void> {
    if (liveTimer !== null) {
      clearTimeout(liveTimer);
    }
    const mySeq = ++liveSeq;
    liveTimer = setTimeout(async () => {
      try {
        const items = await invoke<OutlineItem[]>("parse_outline_str", { text });
        // 过期返回（期间又有新变更）直接丢弃，防回跳
        if (mySeq !== liveSeq) return;
        outline.value = items;
      } catch {
        // 编辑态解析失败不打断编辑，保留当前大纲
      }
    }, LIVE_DEBOUNCE_MS);
  }

  // 编辑内容变化 → 实时刷新大纲（仅当启用且存在文件）
  if (content) {
    watch(content, (text) => {
      if (!filePath.value) return;
      if (!isLiveEnabled()) return;
      void updateLiveText(text);
    });
  }

  return {
    outline,
    loading,
    error,
    updateLiveText,
  };
}
