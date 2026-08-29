/**
 * platform 单元测试
 */
import { describe, it, expect } from "vitest";
import { isMac, detectPlatform, type AppPlatform } from "./platform";

function withUserAgent(ua: string, check: () => void): void {
  const original = navigator.userAgent;
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
  try {
    check();
  } finally {
    Object.defineProperty(navigator, "userAgent", { value: original, configurable: true });
  }
}

describe("platform - detectPlatform", () => {
  it("macOS 用户代理识别为 mac", () => {
    withUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36", () => {
      expect(detectPlatform()).toBe<AppPlatform>("mac");
      expect(isMac()).toBe(true);
    });
  });
});