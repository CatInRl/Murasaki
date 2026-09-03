import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ref } from "vue";
import type { OutlineItem } from "../types";
import { useOutline } from "./useOutline";

// ===== Mock @tauri-apps/api/core =====
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";

const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

function makeItem(level: number, text: string, line: number): OutlineItem {
  return { level, text, line };
}

describe("useOutline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedInvoke.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("路径变化时拉取磁盘大纲", async () => {
    const path = ref<string | null>(null);
    mockedInvoke.mockResolvedValue([makeItem(1, "H1", 1)]);
    const { outline } = useOutline(path);
    path.value = "/a.md";
    await Promise.resolve();
    await Promise.resolve();
    expect(outline.value).toEqual([makeItem(1, "H1", 1)]);
  });

  it("updateLiveText 防抖：窗口内到期后才解析一次", async () => {
    const path = ref<string | null>("/a.md");
    mockedInvoke.mockResolvedValue([makeItem(2, "实时标题", 1)]);
    const { outline, updateLiveText } = useOutline(path);

    // 排空初始 watch 的 parse_outline 拉取，忽略其对调用计数的影响
    await Promise.resolve();
    await Promise.resolve();
    mockedInvoke.mockClear();

    updateLiveText("# 一");
    updateLiveText("# 一二");
    updateLiveText("# 一二三"); // 三次调用只应触发一次
    expect(mockedInvoke).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    // 防抖合并，parse_outline_str 只调用一次，且用最后一次文本
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith("parse_outline_str", {
      text: "# 一二三",
    });
    expect(outline.value).toEqual([makeItem(2, "实时标题", 1)]);
  });

  it("序列号丢弃过期返回，防大纲回跳", async () => {
    const path = ref<string | null>("/a.md");
    // 仅统计 parse_outline_str：初始 watch 的 parse_outline 返回空，不计入 pending
    const pending: Array<{
      seq: number;
      resolve: (v: OutlineItem[]) => void;
    }> = [];
    const textOrder: string[] = [];
    mockedInvoke.mockImplementation((cmd: string, args: { text: string }) => {
      if (cmd !== "parse_outline_str") return Promise.resolve([]);
      textOrder.push(args.text);
      return new Promise<OutlineItem[]>((resolve) => {
        pending.push({ seq: pending.length + 1, resolve });
      });
    });

    const { outline, updateLiveText } = useOutline(path);
    await Promise.resolve();
    await Promise.resolve(); // 排空初始拉取

    // 第一次变更触发 invoke#1（防抖到期）
    updateLiveText("# A");
    await vi.advanceTimersByTimeAsync(200);
    expect(pending.length).toBe(1);

    // 第二次变更触发 invoke#2
    updateLiveText("# B");
    await vi.advanceTimersByTimeAsync(200);
    expect(pending.length).toBe(2);
    expect(textOrder).toEqual(["# A", "# B"]);

    // invoke#2 先返回（写回最新 B）
    pending[1].resolve([makeItem(1, "B", 1)]);
    await Promise.resolve();
    expect(outline.value).toEqual([makeItem(1, "B", 1)]);

    // invoke#1 后返回（旧数据），应被序列号丢弃
    pending[0].resolve([makeItem(1, "旧A", 1)]);
    await Promise.resolve();
    expect(outline.value).toEqual([makeItem(1, "B", 1)]);
  });

  it("编辑态解析失败保留当前大纲不报错", async () => {
    const path = ref<string | null>("/a.md");
    mockedInvoke.mockRejectedValue(new Error("boom"));
    const { outline, updateLiveText } = useOutline(path);

    await updateLiveText("# 标题");
    await vi.advanceTimersByTimeAsync(200);
    expect(outline.value).toEqual([]);
  });
});