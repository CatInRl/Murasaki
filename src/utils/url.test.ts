import { describe, it, expect } from "vitest";
import { isExternalUrl } from "./url";

describe("utils/url", () => {
  describe("isExternalUrl", () => {
    it("识别 http/https URL", () => {
      expect(isExternalUrl("https://example.com/img.png")).toBe(true);
      expect(isExternalUrl("http://example.com/img.png")).toBe(true);
    });
    it("识别 ftp/mailto/tel/file 协议", () => {
      expect(isExternalUrl("ftp://example.com/file")).toBe(true);
      expect(isExternalUrl("mailto:test@example.com")).toBe(true);
      expect(isExternalUrl("tel:+8613800000000")).toBe(true);
      expect(isExternalUrl("file:///C:/path/file.txt")).toBe(true);
    });
    it("非 URL 返回 false", () => {
      expect(isExternalUrl("assets/img.png")).toBe(false);
      expect(isExternalUrl("C:\\images\\img.png")).toBe(false);
      expect(isExternalUrl("/home/user/img.png")).toBe(false);
      expect(isExternalUrl("data:image/png;base64,...")).toBe(false);
    });
  });
});
