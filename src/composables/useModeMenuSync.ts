import { watch, type Ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { EditorMode } from "../types";

/**
 * 将「实际生效的显示模式」回推原生菜单勾选（issue #381）。
 *
 * settings.editorMode 是全局偏好，而 App.vue 的 effectiveEditorMode 会按
 * 文件类型强制降级（source-only 文件强制 source、html 的 wysiwyg 降为
 * split）。菜单勾选应反映生效值而非偏好值，故统一由本 watch 按生效模式
 * 推送，取代原先散落三处「按全局设置推送」（useAppLifecycle watcher /
 * settings://saved / App.vue onMounted）——它们会把 source-only 文件上的
 * 菜单勾选拽回偏好值，造成勾选与实际编辑器行为脱节。
 *
 * Rust 侧 set_mode_checked 按窗口写入 WindowUiState；非活动窗口不抢菜单
 * 显示（焦点切回时由 apply_checked_for_window 重放），多窗口安全。
 */
export function useModeMenuSync(mode: Ref<EditorMode>): void {
  watch(
    mode,
    (m) => {
      void invoke("set_mode_checked", { modeId: "mode-" + m }).catch(
        (err: unknown) => console.warn("同步显示模式菜单勾选失败:", err)
      );
    },
    { immediate: true }
  );
}
