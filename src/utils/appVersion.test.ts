import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(),
}));

import { getVersion } from "@tauri-apps/api/app";
import { getAppVersion } from "./appVersion";

const mockedGetVersion = getVersion as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedGetVersion.mockReset();
});

describe("getAppVersion", () => {
  it("正常返回打包版本号", async () => {
    mockedGetVersion.mockResolvedValue("0.9.0");
    await expect(getAppVersion()).resolves.toBe("0.9.0");
  });

  it("非 Tauri 环境读取失败 → 降级为 0.0.0", async () => {
    mockedGetVersion.mockRejectedValue(new Error("not in tauri"));
    await expect(getAppVersion()).resolves.toBe("0.0.0");
  });

  it("支持自定义降级值", async () => {
    mockedGetVersion.mockRejectedValue(new Error("not in tauri"));
    await expect(getAppVersion("dev")).resolves.toBe("dev");
  });
});