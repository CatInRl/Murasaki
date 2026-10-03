/**
 * useModeMenuSync 单元测试（issue #381）
 *
 * 实际生效的显示模式（effectiveEditorMode，含 source-only / html 降级）
 * 回推原生菜单勾选，而非全局设置值 —— 菜单勾选必须反映当前激活 tab 的真实模式。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

import { ref, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useModeMenuSync } from "./useModeMenuSync";
import type { EditorMode } from "../types";

const invokeMock = vi.mocked(invoke);

describe("useModeMenuSync - 实际生效模式回推菜单勾选（issue #381）", () => {
  beforeEach(() => {
    invokeMock.mockClear();
  });

  it("挂载时立即按当前生效模式推送一次", async () => {
    const mode = ref<EditorMode>("wysiwyg");
    useModeMenuSync(mode);
    await nextTick();
    expect(invokeMock).toHaveBeenCalledWith("set_mode_checked", {
      modeId: "mode-wysiwyg",
    });
  });

  it("生效模式变化时推送新值（如切到 source-only 文件降级为 source）", async () => {
    const mode = ref<EditorMode>("split");
    useModeMenuSync(mode);
    await nextTick();
    invokeMock.mockClear();

    mode.value = "source";
    await nextTick();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("set_mode_checked", {
      modeId: "mode-source",
    });
  });

  it("切回 markdown 文件生效模式还原时再次推送", async () => {
    const mode = ref<EditorMode>("source");
    useModeMenuSync(mode);
    await nextTick();
    invokeMock.mockClear();

    mode.value = "wysiwyg";
    await nextTick();

    expect(invokeMock).toHaveBeenCalledWith("set_mode_checked", {
      modeId: "mode-wysiwyg",
    });
  });
});
