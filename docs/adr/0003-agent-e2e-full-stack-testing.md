# ADR-0003: Agent 全功能 E2E 测试采用双轨注入

**日期**：2026-07-28

**状态**：Accepted

## 背景

Agent 能力分为 A–G 七层（见 CONTEXT.md § Agent 能力分层），其中 C–G 层涉及真实 LLM 调用，需要有效的 API key 才能测试。而 A–B 层已有 E2E 覆盖，绕过 LLM。

用户要求补齐 A–G 全部七层的全功能 E2E 测试，并提供真实 API key。

## 决策

采用双轨注入策略：

1. **UI 路径**（api-providers.spec.ts）：新增一个测试通过设置页面 UI 真实配置 provider，覆盖表单、按钮、测试连接等 UI 行为。完成后清理。
2. **编程式注入**（C–G 层各 spec）：通过 `useAiProvidersStore.saveProvider()` 编程式注入真实 API key 作为测试 fixture，各 spec 在 `beforeAll` 注入、`afterAll` 调用 `deleteProvider` 清理。

### 不选的理由

- **每层独立走 UI**：太慢，UI brittle，重复劳动。
- **全局 shared setup 走一次 UI**：vitest 默认随机顺序，跨 spec 隐式依赖不可靠。
- **仅 UI 注入、其他 spec 复用**：破坏了测试隔离性——某个 spec 删了 provider 会导致后续 spec 失败。
- **仅编程式注入**：会漏测设置 UI 本身。

## 后果

- 新增 `ai-providers.spec.ts` 内 UI 配置测试用例
- 新增 `e2e/helpers/fixtures.ts` 内 `setupActiveProvider()` 和 `teardownActiveProvider()` 辅助函数
- C–G 层各 spec 需在 `beforeAll`/`afterAll` 调用上述辅助
- `secrets.json` 在 `afterAll` 统一清理，不残留 key 密文
