# ADR 0011: Provider 接口抽象 + 双实现（OpenAI + Anthropic）

## 状态

已接受

## 背景

0.2.0 起 Agent 仅支持「OpenAI 兼容」端点（[OpenAICompatibleProvider.ts](../../src/agent/OpenAICompatibleProvider.ts)），通过 `baseURL / apiKey / model` 配置任意兼容端点（DeepSeek / OpenAI / 自定义）。`AiProvider.type` 当前为 `"deepseek" | "openai" | "custom"`，三者走同一实现。

0.4.0 将支持 Anthropic（Claude 系列）。原 issue #98 标题为「Azure OpenAI 集成」，经 grilling 重新定位：Azure 与 OpenAI 协议兼容、价值有限（已有 `custom` 端点可填 Azure），而 Anthropic 协议不兼容、用户需求明确，故改为「OpenAI + Anthropic 双实现」。

核心问题：Anthropic Messages API 与 OpenAI Chat Completions API 在三个维度不兼容，无法通过 `baseURL` 切换：

1. **消息结构** —— OpenAI 把 `system` 放在 `messages` 数组首项；Anthropic 把 `system` 作为顶层参数，`messages` 数组只含 `user` / `assistant`。
2. **流式协议** —— OpenAI SSE 单一 `data: {choices:[{delta:{content,tool_calls}}]}` 格式；Anthropic SSE 分 `message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop` 多事件类型，文本与工具调用分别走 `text_delta` / `input_json_delta`。
3. **工具调用** —— OpenAI 在 `delta.tool_calls[]` 累积 `id` / `function.name` / `function.arguments`（JSON 字串）；Anthropic 在 `content_block_start` 给出 `tool_use.id` / `tool_use.name`，`input` 通过后续 `input_json_delta` 增量拼接。工具结果回传也不同：OpenAI 用 `{role:"tool", tool_call_id, content}` 消息；Anthropic 用 `{role:"user", content:[{type:"tool_result", tool_use_id, content}]}` 内容块。

调用方 [useAgentStore.ts](../../src/stores/useAgentStore.ts) 当前直接 `new OpenAICompatibleProvider(...)` 并调用 `streamChatWithTools(messages, tools, callbacks, signal)`，内部维护「LLM 消息数组」采用 OpenAI 格式（`{role, content}` + `tool_calls` + `tool` 角色消息）。

## 决策

引入 **Provider 接口抽象 + 双实现 + 工厂函数**，三部分如下：

### 1. Provider 接口

抽取 [OpenAICompatibleProvider.ts](../../src/agent/OpenAICompatibleProvider.ts) 现有的 `ProviderConfig` / `StreamCallbacks` / `StreamChatWithToolsResult` 为共享类型，新增 `Provider` 接口：

```typescript
export interface Provider {
  /** 流式聊天补全（无工具调用） */
  streamChat(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<void>;

  /** 流式聊天补全 + 工具调用支持 */
  streamChatWithTools(
    messages: ChatMessage[],
    tools: ToolSpec[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<StreamChatWithToolsResult>;
}
```

- `ChatMessage` 沿用 OpenAI 风格（`role: "system" | "user" | "assistant"` + 可选 `tool_calls` + 可选 `tool_call_id`），作为**调用方与 Provider 之间的统一契约**。
- `ToolSpec` 沿用 OpenAI 的 `{type:"function", function:{name,description,parameters}}` 形态。
- `StreamChatWithToolsResult` 保持现有结构（`hasToolCalls` / `toolCalls: [{id,name,arguments}]` / `usage`）。

**关键约束：调用方（useAgentStore）零改动**。`useAgentStore` 继续用 OpenAI 风格消息数组与工具规格，Provider 实现负责在内部做协议翻译。

### 2. 双实现

- **OpenAICompatibleProvider**（现有）—— 实现 `Provider` 接口，行为不变。`streamChatWithTools` 继续走原生 fetch + SSE 解析（已验证在 WebView2 中稳定）。
- **AnthropicProvider**（新增）—— 实现 `Provider` 接口，内部做三件翻译：
  1. **请求体翻译** —— 把 OpenAI 风格 `messages` 拆出 `system` 到顶层；把 `tool_calls` 翻译为 `content: [{type:"tool_use", id, name, input}]`；把 `{role:"tool", tool_call_id, content}` 翻译为 `{role:"user", content:[{type:"tool_result", tool_use_id, content}]}`；`tools` 翻译为 Anthropic 的 `tools: [{name, description, input_schema}]`。
  2. **流式响应翻译** —— 监听 Anthropic SSE 事件：`content_block_delta` 中的 `text_delta` → `onToken(content)`；`content_block_start` 中的 `tool_use` → 记录 `id` / `name`；`input_json_delta` → 累积 `arguments` 字串；`message_delta` 中的 `usage` → 填充 `StreamChatWithToolsResult.usage`（注意 Anthropic 的 `input_tokens` / `output_tokens` 映射到 `prompt_tokens` / `completion_tokens`）。
  3. **工具调用结果归一化** —— 输出 `StreamChatWithToolsResult.toolCalls` 与 OpenAI 实现完全一致的结构，调用方无感知。

### 3. 工厂函数

```typescript
export function createProvider(config: ProviderConfig & { type: ProviderType }): Provider {
  switch (config.type) {
    case "anthropic":
      return new AnthropicProvider(config);
    case "openai":
    case "deepseek":
    case "custom":
    default:
      return new OpenAICompatibleProvider(config);
  }
}
```

`useAgentStore` 把 `new OpenAICompatibleProvider(...)` 改为 `createProvider({...})`，传入 `type` 字段。

### 4. AiProvider.type 扩展

[types.ts](../../src/types.ts) 的 `AiProvider.type` 由 `"deepseek" | "openai" | "custom"` 扩展为 `"deepseek" | "openai" | "anthropic" | "custom"`。`AI_PROVIDER_PRESETS` 新增 Anthropic 预设（`baseUrl: "https://api.anthropic.com"`，`model: "claude-sonnet-4-5-20250929"` 或当前可用模型）。

设置面板 [AiPanel.vue](../../src/settings/panels/AiPanel.vue) 的 type 选择器新增「Anthropic」选项。删除文件顶部「移除 Azure OpenAI 选项」注释（已无 Azure 概念）。

## 理由

1. **接口抽象是唯一能同时满足「调用方零改动」与「协议不兼容」的方案** —— Anthropic 无法通过 `baseURL` 兼容，必须有独立实现；若不抽象接口，`useAgentStore` 会塞满 `if (type === "anthropic")` 分支，破坏现有流式循环与上下文压缩逻辑的可读性。
2. **OpenAI 风格作为内部统一契约** —— 现有 `useAgentStore` / `compressContext` / `tokenTracker` / 工具调用循环全部基于 OpenAI 风格消息，改造成本高且风险大。让 Anthropic 实现做单向翻译（入：OpenAI→Anthropic；出：Anthropic→OpenAI），是最小侵入路径。
3. **工厂函数隔离类型判断** —— `useAgentStore` 只调 `createProvider(config)`，类型分支集中在工厂，新增第三种协议（如 Google Gemini）只需加一个 case。
4. **复用现有 SSE 解析经验** —— `OpenAICompatibleProvider.streamChatWithTools` 已用原生 fetch + ReadableStream 替代 openai npm 的 iterator（WebView2 兼容性问题），AnthropicProvider 沿用同一模式，避免重踩坑。
5. **usage 归一化为软上限跟踪服务** —— `StreamChatWithToolsResult.usage` 是 `tokenTracker` 的精确值来源，两个实现都填充它，上下文压缩与软上限逻辑无需感知协议差异。

## 备选方案

**统一用 OpenAI SDK 的适配器模式** —— 让 AnthropicProvider 内部调 `openai` npm 包但重写请求/响应。被否决：`openai` npm 包的 stream iterator 在 WebView2 中已证实 hang（现有代码注释明确），Anthropic 走原生 fetch 更稳。

**LangChain.js / Vercel AI SDK** —— 引入第三方 LLM 框架统一多 Provider。被否决：引入重依赖、bundle 体积膨胀、抽象层不可控（流式行为/工具调用细节被框架封装，debug 困难）、与项目「最小依赖」原则不符。项目只有两种协议，自建翻译层成本低于引入框架。

**协议探测而非显式 type** —— 不在 `AiProvider` 加 `type` 字段，而是请求时探测端点协议。被否决：探测增加首次请求延迟、失败路径复杂（端点可能 404 才知道协议不对）、用户体验差。显式 `type` 是用户在设置里主动选的，明确可靠。

## 后果

**正面**
- `useAgentStore` / `compressContext` / `tokenTracker` / 工具循环零改动，降低回归风险。
- 新增协议只需实现 `Provider` 接口 + 工厂加 case，扩展性清晰。
- 用户可在设置里同时配置 OpenAI 兼容和 Anthropic provider，切换 `isActive` 即换协议。

**负面**
- AnthropicProvider 内部翻译逻辑有一定复杂度（消息结构 + 流式事件 + 工具调用三处），需配套单元测试覆盖翻译正确性。
- `AiProvider.type` 字段需迁移：现有 provider 默认 `"custom"`，不影响功能；新增 `"anthropic"` 后旧数据无需迁移（默认值兼容）。
- Anthropic 的 `system` 是顶层字符串，而 OpenAI 风格允许多条 system 消息。翻译时把所有 `role:"system"` 消息合并为一条字串（用 `\n\n` 连接），可能影响极少数依赖多 system 消息顺序的场景（项目当前只有一条 system prompt，无影响）。

## 实施边界

### 文件改动

- 新建 `src/agent/Provider.ts` —— 接口定义 + 共享类型（`Provider` / `ChatMessage` / `ToolSpec` / `StreamCallbacks` / `StreamChatWithToolsResult` / `ProviderConfig` / `ProviderType` / `createProvider`）。
- 改 `src/agent/OpenAICompatibleProvider.ts` —— `implements Provider`，导出类型从本文件迁移到 `Provider.ts`（保留 re-export 兼容）。
- 新建 `src/agent/AnthropicProvider.ts` —— 实现 `Provider` 接口，含请求体翻译 / 流式解析 / 工具调用归一化。
- 改 `src/stores/useAgentStore.ts` —— `new OpenAICompatibleProvider(...)` → `createProvider({type: activeProvider.type, ...})`。
- 改 `src/types.ts` —— `AiProvider.type` 加 `"anthropic"`；`AI_PROVIDER_PRESETS` 加 Anthropic 预设。
- 改 `src/settings/panels/AiPanel.vue` —— type 选择器加「Anthropic」选项，移除 Azure 注释。

### 测试

- `AnthropicProvider` 单元测试：用固定 SSE 流 fixture 验证文本 token 回调、工具调用累积、usage 解析、abort 处理。
- 翻译层测试：OpenAI 风格消息（含 system / tool_calls / tool 结果）→ Anthropic 请求体的双向转换正确性。
- `useAgentStore` 现有测试不动（依赖 `OpenAICompatibleProvider` 的 mock，接口不变故 mock 不变）。

### 范围外

- Google Gemini / 其他协议 —— 0.4.0 不做，工厂预留 case 扩展点。
- Anthropic 的 `thinking` / `extended_thinking` 模式 —— 0.4.0 不做，与 OpenAI 端的 thinking 参数一同在后续版本启用。
- 多模态（图片输入） —— 0.4.0 不做，`ChatMessage.content` 仍为 string。
