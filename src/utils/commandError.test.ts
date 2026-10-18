import { describe, it, expect, beforeEach } from "vitest";
import { i18n } from "../i18n";
import { formatCommandError, parseCommandError } from "./commandError";

describe("utils/commandError", () => {
  beforeEach(() => {
    i18n.global.locale.value = "zh-CN";
  });

  it("解析结构化错误", () => {
    expect(
      parseCommandError({ code: "not_found", params: { path: "C:/ws/a.md" } })
    ).toEqual({ code: "not_found", params: { path: "C:/ws/a.md" } });
  });

  it("params 缺失时归一为空对象", () => {
    expect(parseCommandError({ code: "internal" })).toEqual({
      code: "internal",
      params: {},
    });
  });

  it("旧式字符串错误退化为 unknown + detail", () => {
    expect(parseCommandError("路径不存在")).toEqual({
      code: "unknown",
      params: { detail: "路径不存在" },
    });
  });

  it("Error 实例退化为 unknown + message", () => {
    expect(parseCommandError(new Error("boom"))).toEqual({
      code: "unknown",
      params: { detail: "boom" },
    });
  });

  it("按 code 渲染文案并追加路径", () => {
    expect(
      formatCommandError({ code: "not_found", params: { path: "C:/ws/a.md" } })
    ).toBe("找不到文件或目录：C:/ws/a.md");
  });

  it("io 错误附带系统原文", () => {
    expect(
      formatCommandError({
        code: "io",
        params: { path: "C:/ws/a.md", detail: "Access is denied" },
      })
    ).toBe("文件读写失败：C:/ws/a.md（Access is denied）");
  });

  it("未知 code 回退到 unknown 文案", () => {
    expect(formatCommandError({ code: "future_code" })).toBe("未知错误");
  });

  it("切换语言后文案跟随", () => {
    i18n.global.locale.value = "en";
    expect(formatCommandError({ code: "timeout" })).toBe("Operation timed out");
    i18n.global.locale.value = "zh-CN";
  });
});
