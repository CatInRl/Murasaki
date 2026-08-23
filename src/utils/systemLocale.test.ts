/**
 * 系统语言映射测试（issue #141）
 */
import { describe, it, expect } from "vitest";
import { mapSystemLocale } from "./systemLocale";

describe("utils/systemLocale.mapSystemLocale", () => {
  it("含 zh 的 locale → zh-CN", () => {
    expect(mapSystemLocale("zh-CN")).toBe("zh-CN");
    expect(mapSystemLocale("zh_TW")).toBe("zh-CN");
    expect(mapSystemLocale("ZH-Hant")).toBe("zh-CN");
    expect(mapSystemLocale("zh")).toBe("zh-CN");
  });

  it("含 ja 的 locale → ja", () => {
    expect(mapSystemLocale("ja")).toBe("ja");
    expect(mapSystemLocale("ja-JP")).toBe("ja");
  });

  it("含 en 的 locale → en", () => {
    expect(mapSystemLocale("en")).toBe("en");
    expect(mapSystemLocale("en-US")).toBe("en");
    expect(mapSystemLocale("en-GB")).toBe("en");
  });

  it("其他语言 / null / undefined → en", () => {
    expect(mapSystemLocale("fr-FR")).toBe("en");
    expect(mapSystemLocale("de")).toBe("en");
    expect(mapSystemLocale("ru_RU")).toBe("en");
    expect(mapSystemLocale(null)).toBe("en");
    expect(mapSystemLocale(undefined)).toBe("en");
    expect(mapSystemLocale("")).toBe("en");
  });
});