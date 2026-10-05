/**
 * 外部修改三选一对话框测试（issue #378）
 *
 * 修复前的两个问题：
 * - 破坏性动作「加载磁盘版本」占据主按钮（primary，视觉层级最高），
 *   「保留本地版本」反而放在中间次按钮 —— 按钮层级与动作风险倒挂
 * - 主按钮点击 → 本地未保存内容被磁盘内容直接覆盖且无草稿兜底
 *   （草稿兜底在 store 层修复，见 useTabsStore.test.ts）
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { i18n } from "../i18n";
import {
  useCompareWindow,
  type CompareWindowDeps,
  type TabsStoreLike,
  type DialogLike,
} from "./useCompareWindow";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
const invokeSpy = invoke as unknown as ReturnType<typeof vi.fn>;

const t = i18n.global.t.bind(i18n.global);

/** 依赖替身：不标注返回类型（Mock 与接口函数签名的交叉类型过严），传入时统一收窄 */
function makeTabsStore() {
  return {
    getTabByPath: vi.fn(() => ({
      id: "t1",
      path: "C:/ws/a.md",
      content: "本地未保存的修改",
      isDirty: true,
      lastMtime: 123,
    })),
    reloadFromDisk: vi.fn(async () => {}),
    applyExternalResolution: vi.fn(async () => {}),
    markExternalChange: vi.fn(),
    writeMergedContent: vi.fn(async () => {}),
  };
}

function makeDialog(result: "save" | "discard" | "cancel") {
  return {
    alert: vi.fn(),
    unsavedChanges: vi.fn(async () => result),
  };
}

type TabsStoreSpy = ReturnType<typeof makeTabsStore> & TabsStoreLike;
type DialogSpy = ReturnType<typeof makeDialog> & DialogLike;

function asDeps(tabsStore: TabsStoreSpy, dialog: DialogSpy): CompareWindowDeps {
  return { tabsStore, dialog } as unknown as CompareWindowDeps;
}

beforeEach(() => {
  invokeSpy.mockReset();
  invokeSpy.mockImplementation(async (cmd: string) => {
    if (cmd === "get_file_mtime") return 456;
    if (cmd === "read_text_file") return "磁盘新内容";
    return undefined;
  });
});

describe("useCompareWindow 三选一按钮语义（#378）", () => {
  it("主按钮是保守动作「保留本地版本」，破坏性动作「加载磁盘版本」降级为中间按钮", async () => {
    const tabsStore = makeTabsStore();
    const dialog = makeDialog("save");
    const { handleExternalChange } = useCompareWindow(asDeps(tabsStore, dialog));

    await handleExternalChange("C:/ws/a.md");

    expect(dialog.unsavedChanges).toHaveBeenCalledTimes(1);
    const args = dialog.unsavedChanges.mock.calls[0] as unknown as [
      { saveText: string; discardText: string; cancelText: string }
    ];
    const opts = args[0];
    expect(opts.saveText).toBe(t("common.keepLocalVersion"));
    expect(opts.discardText).toBe(t("common.loadDiskVersion"));
    expect(opts.cancelText).toBe(t("common.compareAndMerge"));
  });

  it("选主按钮（保留本地）走 keep-local，绝不触发 load-disk", async () => {
    const tabsStore = makeTabsStore();
    const dialog = makeDialog("save");
    const { handleExternalChange } = useCompareWindow(asDeps(tabsStore, dialog));

    await handleExternalChange("C:/ws/a.md");

    expect(tabsStore.applyExternalResolution).toHaveBeenCalledTimes(1);
    expect(tabsStore.applyExternalResolution).toHaveBeenCalledWith("C:/ws/a.md", "keep-local");
    expect(tabsStore.applyExternalResolution).not.toHaveBeenCalledWith(
      "C:/ws/a.md",
      "load-disk",
      expect.anything()
    );
  });

  it("选中间按钮（加载磁盘）走 load-disk 并带磁盘内容", async () => {
    const tabsStore = makeTabsStore();
    const dialog = makeDialog("discard");
    const { handleExternalChange } = useCompareWindow(asDeps(tabsStore, dialog));

    await handleExternalChange("C:/ws/a.md");

    expect(tabsStore.applyExternalResolution).toHaveBeenCalledTimes(1);
    expect(tabsStore.applyExternalResolution).toHaveBeenCalledWith(
      "C:/ws/a.md",
      "load-disk",
      "磁盘新内容"
    );
  });

  it("选取消打开对比窗口（不丢弃任何一侧内容）", async () => {
    const tabsStore = makeTabsStore();
    const dialog = makeDialog("cancel");
    const { handleExternalChange, compareState } = useCompareWindow(asDeps(tabsStore, dialog));

    await handleExternalChange("C:/ws/a.md");

    expect(tabsStore.applyExternalResolution).not.toHaveBeenCalled();
    expect(compareState.value.visible).toBe(true);
    expect(compareState.value.externalContent).toBe("磁盘新内容");
    expect(compareState.value.localContent).toBe("本地未保存的修改");
  });
});
