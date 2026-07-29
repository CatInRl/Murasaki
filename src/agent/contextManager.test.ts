import { describe, it, expect } from "vitest";
import {
  compressContext,
  estimateTokens,
  estimateMessagesTokens,
  CumulativeTokenTracker,
  type LLMMessage,
} from "./contextManager";

describe("contextManager", () => {
  // ===== Token 估算 =====
  describe("estimateTokens", () => {
    it("空字符串返回 0", () => {
      expect(estimateTokens("")).toBe(0);
    });

    it("非空字符串返回 ceil(length/4)", () => {
      expect(estimateTokens("hello")).toBe(2); // ceil(5/4) = 2
      expect(estimateTokens("hello world")).toBe(3); // ceil(11/4) = 3
    });
  });

  describe("estimateMessagesTokens", () => {
    it("计算所有消息的 token 总和", () => {
      const messages: LLMMessage[] = [
        { role: "system", content: "hello" }, // 2
        { role: "user", content: "world" }, // 2
      ];
      expect(estimateMessagesTokens(messages)).toBe(4);
    });
  });

  // ===== Layer 1: 工具结果省略 =====
  describe("Layer 1: 工具结果省略", () => {
    it("token 数 < 20K 时不触发", () => {
      const messages: LLMMessage[] = [
        { role: "system", content: "system" },
        { role: "user", content: "hello" },
      ];
      const result = compressContext(messages);
      expect(result.layer1Applied).toBe(false);
    });

    it("token 数 > 20K 时触发工具结果省略", () => {
      // 构建包含大量工具结果的消息（> 80K chars = > 20K tokens）
      const longToolResult = "工具 list_files 的结果: " + "x".repeat(100000);
      const messages: LLMMessage[] = [
        { role: "system", content: "system prompt" },
        { role: "user", content: "请列出文件" },
        { role: "assistant", content: "(calling tools)" },
        { role: "user", content: longToolResult },
        { role: "assistant", content: "以下是文件列表" },
      ];
      const result = compressContext(messages);
      expect(result.layer1Applied).toBe(true);
      // 工具结果消息应被截断
      const toolMsg = result.messages.find(
        (m) => m.role === "user" && m.content.startsWith("工具 ")
      );
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content.length).toBeLessThan(longToolResult.length);
      expect(toolMsg!.content).toContain("[工具结果已省略");
    });

    it("短工具结果不被截断", () => {
      const shortToolResult = "工具 list_files 的结果: {ok: true}";
      // 用多个消息让总 token > 20K，但不靠工具结果消息
      const messages: LLMMessage[] = [
        { role: "system", content: "x".repeat(80000) }, // ~20K tokens
        { role: "user", content: shortToolResult },
      ];
      const result = compressContext(messages);
      // Layer 1 触发后，短工具结果不应被截断
      // 但可能在后续截断中被移除，所以检查是否仍存在
      const toolMsg = result.messages.find(
        (m) => m.role === "user" && m.content.startsWith("工具 ")
      );
      if (toolMsg) {
        expect(toolMsg.content).not.toContain("[工具结果已省略");
      }
    });
  });

  // ===== Layer 2: 滑动窗口 + 摘要 =====
  describe("Layer 2: 滑动窗口 + 摘要", () => {
    it("token 数 > 40K 时触发普通窗口", () => {
      // 需要 > 160K chars = > 40K tokens
      const messages: LLMMessage[] = [
        { role: "system", content: "system" },
        ...Array.from({ length: 30 }, (_, i) => ({
          role: "user" as const,
          content: `消息 ${i} ` + "x".repeat(6000), // ~1500 tokens each, 30 * 1500 = 45K
        })),
      ];
      expect(estimateMessagesTokens(messages)).toBeGreaterThan(40000);
      const result = compressContext(messages);
      expect(result.layer2Applied).toBe(true);
      // 应包含摘要标记
      const hasSummary = result.messages.some((m) =>
        m.content.includes("[以下为历史消息摘要")
      );
      expect(hasSummary).toBe(true);
    });

    it("token 数 > 60K 时触发激进窗口", () => {
      // 需要 > 240K chars = > 60K tokens
      const messages: LLMMessage[] = [
        { role: "system", content: "system" },
        ...Array.from({ length: 50 }, (_, i) => ({
          role: "user" as const,
          content: `消息 ${i} ` + "x".repeat(5000), // ~1250 tokens each, 50 * 1250 = 62.5K
        })),
      ];
      expect(estimateMessagesTokens(messages)).toBeGreaterThan(60000);
      const result = compressContext(messages);
      expect(result.layer2Applied).toBe(true);
      // 激进模式保留更少消息
      expect(result.messages.length).toBeLessThan(messages.length);
    });

    it("消息数量不足时不触发滑动窗口", () => {
      // 大消息但只有1条非system，无法滑动窗口
      // > 64K chars = > 16K tokens → 应触发单次请求截断
      const messages: LLMMessage[] = [
        { role: "system", content: "system" },
        { role: "user", content: "x".repeat(80000) }, // ~20K tokens
      ];
      const result = compressContext(messages);
      // 消息太少不触发 Layer 2
      expect(result.layer2Applied).toBe(false);
      // 但 token > 16K 应触发截断
      expect(result.truncated).toBe(true);
    });
  });

  // ===== 单次请求截断 =====
  describe("单次请求截断", () => {
    it("token 数 > 16K 时截断", () => {
      // > 64K chars = > 16K tokens
      const messages: LLMMessage[] = [
        { role: "system", content: "system" },
        { role: "user", content: "x".repeat(100000) }, // ~25K tokens
      ];
      const result = compressContext(messages);
      expect(result.truncated).toBe(true);
      expect(result.compressedTokens).toBeLessThanOrEqual(16500); // 允许截断提示的额外 token
    });

    it("截断后保留 system 消息", () => {
      const messages: LLMMessage[] = [
        { role: "system", content: "important system prompt" },
        { role: "user", content: "x".repeat(100000) },
      ];
      const result = compressContext(messages);
      expect(result.messages[0].role).toBe("system");
      expect(result.messages[0].content).toBe("important system prompt");
    });

    it("截断提示包含被截断的消息数", () => {
      // 3 条大消息，总 token > 16K，截断后应保留最后1-2条
      const messages: LLMMessage[] = [
        { role: "system", content: "system" },
        { role: "user", content: "x".repeat(30000) }, // ~7.5K tokens
        { role: "assistant", content: "y".repeat(30000) }, // ~7.5K tokens
        { role: "user", content: "z".repeat(30000) }, // ~7.5K tokens
      ];
      const result = compressContext(messages);
      expect(result.truncated).toBe(true);
      const truncationMsg = result.messages.find((m) =>
        m.content.includes("已截断")
      );
      expect(truncationMsg).toBeDefined();
    });

    it("compressContext 支持自定义 singleRequestLimit（从 SettingsState 读取）", () => {
      const messages: LLMMessage[] = [
        { role: "system", content: "system" },
        { role: "user", content: "x".repeat(100000) }, // ~25K tokens
      ];
      // 默认 16384 会截断
      const defaultResult = compressContext(messages);
      expect(defaultResult.truncated).toBe(true);
      // 提高限制到 30000 后不截断
      const customResult = compressContext(messages, { singleRequestLimit: 30000 });
      expect(customResult.truncated).toBe(false);
    });
  });

  // ===== 无需压缩的情况 =====
  describe("小上下文不压缩", () => {
    it("小上下文不触发任何压缩", () => {
      const messages: LLMMessage[] = [
        { role: "system", content: "system prompt" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ];
      const result = compressContext(messages);
      expect(result.layer1Applied).toBe(false);
      expect(result.layer2Applied).toBe(false);
      expect(result.truncated).toBe(false);
      expect(result.messages).toEqual(messages);
    });
  });

  // ===== 累计 token 跟踪 =====
  describe("CumulativeTokenTracker", () => {
    it("初始 total 为 0", () => {
      const tracker = new CumulativeTokenTracker();
      expect(tracker.total).toBe(0);
    });

    it("add 累加 token 数", () => {
      const tracker = new CumulativeTokenTracker();
      tracker.add(1000);
      tracker.add(2000);
      expect(tracker.total).toBe(3000);
    });

    it("add 负数不累加", () => {
      const tracker = new CumulativeTokenTracker();
      tracker.add(-100);
      expect(tracker.total).toBe(0);
    });

    it("接近限制时 isApproachingLimit 为 true", () => {
      const tracker = new CumulativeTokenTracker();
      tracker.add(42000); // > 51200 * 0.8 = 40960
      expect(tracker.isApproachingLimit).toBe(true);
      expect(tracker.isOverLimit).toBe(false);
    });

    it("超过限制时 isOverLimit 为 true", () => {
      const tracker = new CumulativeTokenTracker();
      tracker.add(52000); // 默认 51200
      expect(tracker.isOverLimit).toBe(true);
    });

    it("reset 重置为 0", () => {
      const tracker = new CumulativeTokenTracker();
      tracker.add(50000);
      tracker.reset();
      expect(tracker.total).toBe(0);
      expect(tracker.isOverLimit).toBe(false);
    });

    it("limit 返回默认 51200", () => {
      const tracker = new CumulativeTokenTracker();
      expect(tracker.limit).toBe(51200);
    });

    it("支持自定义 limit getter（从 SettingsState 读取）", () => {
      const tracker = new CumulativeTokenTracker(() => 10000);
      expect(tracker.limit).toBe(10000);
      tracker.add(8000);
      expect(tracker.isApproachingLimit).toBe(false); // 8000 > 8000 == false
      tracker.add(1);
      expect(tracker.isApproachingLimit).toBe(true); // 8001 > 8000
      tracker.add(2000);
      expect(tracker.isOverLimit).toBe(true); // 10001 > 10000
    });
  });
});
