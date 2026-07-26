# DeepSeek Tool-Calling 可靠性调研

> **Wayfinder Ticket**: [R1](https://github.com/CatInRl/Murasaki/issues/6)
> **相关 Ticket**: [T9 Provider 抽象](https://github.com/CatInRl/Murasaki/issues/12) · [T1 循环架构](https://github.com/CatInRl/Murasaki/issues/2)
> **日期**: 2026-07-27
> **研究范围**: DeepSeek API（V3.1+ / V4 系列）tool-calling 能力、OpenAI 兼容性、已知缺陷
> **模型基线**: `deepseek-chat`（非思考模式）/ `deepseek-reasoner`（思考模式），对应 V4-flash 的两种模式；生产推荐 `deepseek-v4-pro`

---

## 1. Executive Summary

DeepSeek API 在协议层高度兼容 OpenAI Chat Completions：`tools`、`tool_choice`、`tool_calls`、`tool` 角色消息、流式 `delta.tool_calls` 增量拼接均与 OpenAI 一致，OpenAI JS SDK 改 `baseURL` 即可跑通基础 tool-calling。自 V3.1（2025-08-21）起官方支持 **`strict: true` Beta 严格模式**（需 `/beta` base_url），并在 strict 模式下提供 `object/string/number/integer/boolean/array/enum/anyOf/$ref/$def` 子集，但 **不支持 `oneOf`、`minLength/maxLength/minItems/maxItems`**。并行工具调用（单次返回多个 `tool_calls`）默认可用，但 **官方 API reference 未文档化 `parallel_tool_calls` 开关参数**。最严重的可靠性问题是 **DSML 标记泄漏**：模型在流式响应中会把内部协议标记（`<‖DSML‖tool_calls>` 等）泄漏到 `delta.content` 字段，污染用户可见文本与 TTS 朗读。官方文档明确警告「模型不总是生成合法 JSON，且可能幻觉出 schema 中不存在的参数」，因此**应用层必须强制校验 arguments 并剥除 DSML 标记**，不能信任 `content` 与 `tool_calls` 通道的严格分离。

---

## 2. Capability Checklist

| 能力 | 状态 | 说明 | 来源 |
|---|---|---|---|
| `tools` 数组（function 类型） | ✅ 支持 | 最多 128 个函数；仅 `type: "function"` | [API ref](https://api-docs.deepseek.com/api/create-chat-completion) |
| `tool_choice: none/auto/required` | ✅ 支持 | 与 OpenAI 语义一致；`auto` 为有 tools 时的默认 | [API ref](https://api-docs.deepseek.com/api/create-chat-completion) |
| `tool_choice: {type:"function", function:{name}}` | ✅ 支持 | 强制指定工具 | [API ref](https://api-docs.deepseek.com/api/create-chat-completion) |
| `strict: true`（严格模式） | ✅ Beta | 需 `base_url="https://api.deepseek.com/beta"`；V3.1+ 引入 | [tool_calls guide](https://api-docs.deepseek.com/guides/tool_calls) |
| strict 模式 schema 子集 | ⚠️ 部分 | 支持 object/string/number/integer/boolean/array/enum/anyOf/$ref/$def；**不支持 oneOf、minLength/maxLength、minItems/maxItems**；object 必须所有属性入 `required` 且 `additionalProperties:false` | [tool_calls guide](https://api-docs.deepseek.com/guides/tool_calls) |
| 并行工具调用（单响应多 tool_calls） | ✅ 默认可用 | 模型可一次返回多个 tool_calls；社区实测有效 | [社区示例](https://blog.csdn.net/yang2330648064/article/details/149810426) |
| `parallel_tool_calls` 开关参数 | ❌ 未文档化 | 官方 API reference 无此参数；社区文章提及 `parallel_tool_calls=true` 但**未获官方证实**，建议不要依赖 | [API ref](https://api-docs.deepseek.com/api/create-chat-completion) |
| 流式 `delta.tool_calls` 增量 | ✅ OpenAI 兼容 | `delta.tool_calls[].function.arguments` 增量拼接；`delta.content` 与 `delta.tool_calls` 双通道分离（但见 §4 DSML 泄漏） | [API ref](https://api-docs.deepseek.com/api/create-chat-completion) |
| `tool` 角色 + `tool_call_id` 回填 | ✅ 支持 | 与 OpenAI 一致；`{role:"tool", tool_call_id, content}` | [tool_calls guide](https://api-docs.deepseek.com/guides/tool_calls) |
| 多轮工具调用 | ✅ 支持 | 历史须保留完整 assistant.tool_calls + tool 结果消息，否则模型「失忆」 | [社区](http://m.toutiao.com/group/7661503519517688355/) |
| 思考模式（reasoner）工具调用 | ✅ 支持（V3.2+） | R1-0528 起支持；V3.2+ 思考模式可多轮 reasoning + tool_calls；**必须把 `reasoning_content` 回传**否则返回 400 | [thinking_mode guide](https://api-docs.deepseek.com/guides/thinking_mode) |
| `finish_reason: "tool_calls"` | ✅ 支持 | 额外含 `insufficient_system_resource`（DeepSeek 专属） | [API ref](https://api-docs.deepseek.com/api/create-chat-completion) |
| `response_format: json_object` | ✅ 支持 | prompt 必须含 "json" 一词；只保证合法 JSON 不保证字段结构 | [json_mode guide](https://api-docs.deepseek.com/guides/json_mode) |
| `frequency_penalty` / `presence_penalty` | ❌ 已废弃 | 传入不报错但不生效 | [API ref](https://api-docs.deepseek.com/api/create-chat-completion) |
| `temperature` / `top_p` | ⚠️ 思考模式无效 | 思考模式下传入不报错但不生效；非思考模式可用 | [thinking_mode guide](https://api-docs.deepseek.com/guides/thinking_mode) |

---

## 3. OpenAI Compatibility Diff

| 特性 | OpenAI 行为 | DeepSeek 行为 | 需要的适配 |
|---|---|---|---|
| base_url | `https://api.openai.com/v1` | `https://api.deepseek.com`（不带 `/v1`；带 `/v1` 也能用但官方推荐不带，旧代理可能 404） | 配置项可切换 |
| 模型名 | `gpt-4o` 等 | `deepseek-v4-pro` / `deepseek-v4-flash`（旧名 `deepseek-chat`/`deepseek-reasoner` 将于 2026-07-24 下线，对应 V4-flash 的非思考/思考模式） | 抽象层 model 映射 |
| `parallel_tool_calls` 参数 | 支持，默认 `true`，可设 `false` 禁用 | **未文档化**；模型按需返回多个 tool_calls，无开关 | 不要传该参数；如需禁用并行，靠 prompt 引导或在应用层串行执行 |
| `strict: true` | 直接在 tools 内设置，无需切 base_url | 需 `base_url="https://api.deepseek.com/beta"`；schema 类型子集更窄（无 oneOf、无长度约束） | provider 配置项 `supportsStrictWithoutBetaUrl=false`；schema 转换器需降级不支持的约束 |
| `reasoning_effort` | o 系列支持 `low/medium/high` | 仅 `high/max`；`low/medium` 映射到 `high`，`xhigh` 映射到 `max` | 映射枚举 |
| 思考模式触发 | 模型自带（o 系列） | 需 `extra_body: {thinking: {type:"enabled"}}`（JS SDK）或顶层 `thinking` 字段；`reasoning_content` 须回传 | provider 配置项 `requiresThinkingToggle=true` |
| 思考模式工具调用 | reasoning 自动随 message 回传 | **必须显式把 `reasoning_content` 放进 assistant 消息回传**，否则 400 | 循环架构须保留 `reasoning_content` 字段 |
| `frequency_penalty`/`presence_penalty` | 生效 | 已废弃，静默忽略 | 不要暴露给用户 |
| `finish_reason` | `stop/length/tool_calls/content_filter` | 额外 `insufficient_system_resource` | 循环须处理此分支（重试或降级） |
| `content` 与 `tool_calls` 通道分离 | 严格分离 | **不严格**：DSML 标记会泄漏到 `content` | 应用层须过滤 DSML（见 §4） |
| `arguments` JSON 合法性 | 偶有不合法 | **官方明文警告不保证合法**，且易幻觉额外字段 | 强制 `JSON.parse` + try/catch + schema 校验 + 宽松取字段 |
| `tool` 消息 `content` 类型 | 支持 string + 多 part | 仅 string（JSON 字符串） | 序列化结果为字符串 |

### 最小可运行示例（OpenAI JS SDK）

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://api.deepseek.com",   // 不带 /v1
  apiKey: process.env.DEEPSEEK_API_KEY!,
  dangerouslyAllowBrowser: false,        // 桌面端经 Rust 后端转发更安全
});

const tools = [
  {
    type: "function" as const,
    function: {
      name: "get_weather",
      description: "Get weather of a location.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City, e.g. Hangzhou" },
        },
        required: ["location"],
      },
    },
  },
];

// 1) 触发工具调用
const resp = await client.chat.completions.create({
  model: "deepseek-v4-pro",
  messages: [{ role: "user", content: "杭州天气？" }],
  tools,
  tool_choice: "auto",
});

const msg = resp.choices[0].message;
if (msg.tool_calls?.length) {
  const call = msg.tool_calls[0];
  // ⚠️ 必须 try/catch：arguments 不保证合法 JSON
  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments);
  } catch (e) {
    // 降级：把错误回填给模型让它重试
    args = { _error: "invalid_arguments", raw: call.function.arguments };
  }

  // 2) 执行工具 + 回填结果
  const result = JSON.stringify({ location: "Hangzhou", temp: "24℃" });
  const final = await client.chat.completions.create({
    model: "deepseek-v4-pro",
    messages: [
      { role: "user", content: "杭州天气？" },
      msg,                                                    // 保留 assistant.tool_calls
      { role: "tool", tool_call_id: call.id, content: result }, // 必须带 tool_call_id
    ],
    tools,
  });
}
```

### Strict 模式（Beta）示例

```typescript
const strictClient = new OpenAI({
  baseURL: "https://api.deepseek.com/beta",   // ← 必须 /beta
  apiKey: process.env.DEEPSEEK_API_KEY!,
});

const strictTools = [
  {
    type: "function" as const,
    function: {
      name: "save_contact",
      strict: true,                          // ← 每个函数都要标
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string", format: "email" },
        },
        required: ["name", "email"],          // ← 所有属性必须入 required
        additionalProperties: false,          // ← 必须为 false
      },
    },
  },
];
```

---

## 4. Known Quirks & Mitigations

### 4.1 DSML 标记泄漏到 `delta.content`（已验证，高严重性）

**现象**：流式响应中模型把内部 DeepSeek Markup Language 协议标记直接输出到 `delta.content`，例如：

```
好的，我先写一首小诗，再念给西溪公主听：

<‖DSML‖tool_calls>
<‖DSML‖invoke name="voice_output_speak">
<‖DSML‖parameter name="text" string="true">西溪公主回城堡...</‖DSML‖parameter>
</‖DSML‖invoke>
</‖DSML‖tool_calls>
```

这些标记会显示在聊天区、被 TTS 朗读、污染 RAG 检索。**同一响应的 `delta.tool_calls` 通道是正常的**，问题在于 `content` 通道未被剥离。

**关键陷阱（Unicode 视觉欺骗）**：实际输出是**双竖线** `‖`（U+FF5C × 2，外加 `DSML` 关键字），而非肉眼难辨的单竖线 `｜`。WeClaw 团队首版过滤器用单竖线标记，匹配率 0/5，长期失效。

**来源**：WeClaw 专栏第 61 篇，含 hex 字节级分析（`efbd9c efbd9c` = 双 `｜`）与 10/10 测试用例。该项目使用 DeepSeek 作为核心推理引擎，是真实生产环境报告。

**缓解**：
1. 流式 `delta.content` 处理时增加前缀过滤：匹配 `<‖DSML‖`、`</‖DSML‖` 起始即截断后续 chunk。
2. 正则兜底覆盖竖线数量变体：`r'</?[｜|]{1,2}(?:DSML[｜|]{1,2})?(?:tool_calls|tool[｜|]{1,2}calls|invoke|parameter)'`。
3. 一旦检测到 DSML 起始，置 `_dsml_started = true`，后续该轮所有 content chunk 全部屏蔽（标记不会在中途结束）。
4. 跨 chunk 边界场景：标记可能被切分到两个 chunk（如 chunk1 末尾 `<`，chunk2 开头 `‖DSML‖`），生产级实现需状态机缓冲；WeClaw 实测 DSML 标记通常与前置文本分属不同 chunk，简单截断已足够。
5. **不要**依赖肉眼判断 Unicode 字符是否匹配——必须 `assert marker in sample`。

### 4.2 `arguments` 不保证合法 JSON（官方明文警告）

官方 API reference 在 `tool_calls.function.arguments` 字段说明里直接写道：

> Note that the model does not always generate valid JSON, and may hallucinate parameters not defined by your function schema. Validate the arguments in your code before calling your function.

**缓解**：
- `JSON.parse(arguments)` 必须 try/catch；失败时把错误作为 tool 结果回填（`{_error: "invalid_json", raw}`），让模型有机会重试。
- 开启 `strict: true` 可显著降低（但非消除）此类问题。
- 不要用 `eval` / `Function` 解析。

### 4.3 幻觉额外参数字段

模型偶尔在 `arguments` 里返回 schema 未定义的字段（如定义只有 `city`，模型加 `unit: "celsius"`）。

**缓解**：函数实现采用宽松模式——只取需要的字段，忽略多余字段；或用 Pydantic / Zod 配置 `strip_unknown`。

### 4.4 `tool_choice: "required"` 选错工具

社区反馈 `required` 模式下模型会调用与用户意图无关的工具（OpenAI 在 `required` 下倾向第一个函数，DeepSeek 无此倾向）。

**缓解**：需要强制调用特定工具时用命名形式 `tool_choice: {type:"function", function:{name:"..."}}`，不要依赖 `required` + 自然语言引导。

### 4.5 多轮上下文丢失导致工具「失忆」

第三轮对话时模型不再调用工具，直接编答案。根因是构建 `messages` 时只放了 user/assistant 普通消息，丢掉了第一轮的 `tool_calls` 和 `tool` 消息。

**缓解**：循环架构须保留**完整** assistant 消息（含 `tool_calls`、`content: null`）+ 对应 `tool` 结果消息；思考模式还要保留 `reasoning_content`。

### 4.6 思考模式 `reasoning_content` 回传缺失 → 400

思考模式下，若 assistant 消息未带 `reasoning_content` 回传，API 返回 400。这条规则仅在**发生过 tool_calls 的轮次**强制；纯对话轮次的 `reasoning_content` 可省略（会被忽略）。

**缓解**：统一策略——所有 thinking 模式的 assistant 消息都保留 `reasoning_content`，不区分是否触发过工具。

### 4.7 中文 arguments 序列化乱码

`function.arguments` 含中文时，重新序列化若不 `ensure_ascii=False`（Python）或不指定 UTF-8 编码会出现乱码。JS 端 `JSON.stringify` 默认 UTF-8 无此问题，但跨语言/存库时需注意。

### 4.8 循环调用 / 空回复

社区报告偶发「模型反复调用同一工具不收敛」或「返回空 content」。属偶发问题，未见官方修复说明。

**缓解**：循环架构设置最大迭代次数（如 8-10 轮），超过即强制终止并把已积累的 tool 结果汇总给用户。

### 4.9 `tool_choice` 索引对齐 / strict-nullable 等传闻（**未证实，存疑**）

某 CSDN 文章声称存在三条「未公开隐式约束」：tool_choice 必须与 tools[0] 对齐、nullable 字段必须显式传 null、system 中提及工具名会触发安全过滤。该文同时声称引用了 DeepSeek Go runtime 源码 `runtime/v2.1.0/llm/step_validator.go`——**DeepSeek 服务端非开源，此源码系虚构**，整篇文章含大量 AI 生成填充内容（mitmproxy、OpenTelemetry、LLaMA-3-8B 等无关技术栈）。**不作为事实采纳**，但建议在集成测试中覆盖 tool_choice 命名工具不在首位、nullable 字段缺失等场景以验证。

---

## 5. Recommended Abstraction Layer Adaptations (for T9)

基于上述发现，T9 的 provider 抽象层应至少暴露以下配置与能力：

### 5.1 Provider 配置 schema

```typescript
interface ProviderConfig {
  baseURL: string;                         // https://api.deepseek.com 或 .../beta
  apiKeyEnv: string;
  defaultModel: string;                     // deepseek-v4-pro
  thinkingModel?: string;                  // deepseek-v4-flash (thinking mode)
  supportsStrictWithoutBetaUrl: boolean;   // DeepSeek = false（strict 需切 /beta）
  supportsParallelToolCallsParam: boolean; // DeepSeek = false
  requiresThinkingToggle: boolean;         // DeepSeek = true
  requiresReasoningContentPassthrough: boolean; // DeepSeek thinking = true
  hasDeprecatedPenalties: boolean;          // DeepSeek = true（freq/presence 静默忽略）
  extraFinishReasons: string[];            // ['insufficient_system_resource']
  dsmlLeakMitigation: boolean;             // DeepSeek = true
}
```

### 5.2 Schema 转换器（DeepSeek strict 降级）

- 自动给所有 `object` 补 `additionalProperties: false` + 所有属性入 `required`。
- 移除不支持的约束：`oneOf` → 改写为 `anyOf`；`minLength/maxLength/minItems/maxItems` → 移除并靠 description 约束。
- `nullable: true` 字段 → 转为 `anyOf: [{type: T}, {type: "null"}]`。
- 若 schema 含 strict 不支持的特性且无法降级，自动回退 `strict: false` 并告警。

### 5.3 响应流处理器

- **DSML 过滤器**：在 `delta.content` 通道前置过滤器，匹配 `<‖DSML‖` 前缀即截断。
- **arguments 校验**：`JSON.parse` 失败不抛异常，生成错误 tool 结果回填。
- **reasoning_content 保留**：thinking 模式下 assistant 消息须携带 `reasoning_content` 字段。
- **finish_reason 路由**：`insufficient_system_resource` 视为可重试错误（带退避）。

### 5.4 循环架构（T1）须保留的消息字段

```typescript
// 多轮工具调用历史最小完整结构
type ToolTurnMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; reasoning_content?: string }
  | { role: "tool"; tool_call_id: string; content: string };
```

- **不要**用 `{role:"assistant", content: null}` 简化带 `tool_calls` 的消息——必须保留 `tool_calls` 原始结构。
- **思考模式**：`reasoning_content` 必须随 assistant 消息回传（仅工具轮次强制，但统一保留更安全）。
- **历史裁剪**：若超出上下文，按「保留最近 N 轮 + 系统消息 + 当前 user」策略，但**不要裁剪中间的 tool 消息而不裁对应的 assistant.tool_calls**——成对删除。

---

## 6. Failure Modes & Recovery

| 失败模式 | 表现 | DeepSeek 自身恢复能力 | 推荐处理 |
|---|---|---|---|
| `arguments` 非法 JSON | `JSON.parse` 抛异常 | 模型不会自动重试 | 把错误回填为 tool 结果：`{_error:"invalid_json", raw}`，下一轮模型通常能修正 |
| 幻觉工具名（调用 tools 里没有的函数） | `tool.function.name` 不在注册表 | 无 | 校验函数名；未注册则回填错误 tool 结果，模型可在下一轮改用正确工具 |
| 幻觉额外参数字段 | arguments 多出 schema 未定义字段 | 无 | 函数实现 `strip_unknown`；或回填警告让模型修正 |
| 模型拒绝调用工具（直接答 content） | `finish_reason: "stop"`，无 tool_calls | 可用 `tool_choice: "required"` 强制 | 若任务强依赖工具，用 `required` 或命名工具重试一轮 |
| 思考模式 400 错误 | API 返回 400 | 无 | 检查 assistant 消息是否带 `reasoning_content`；补全后重发 |
| DSML 标记泄漏到 content | 用户看到 `<‖DSML‖...>` 乱码 | 模型不会自纠 | 应用层过滤；不要把它当作工具调用执行 |
| 循环调用不收敛 | 反复同一工具 | 无 | 硬上限 8-10 轮；超出强制 `tool_choice: "none"` 收尾 |
| `insufficient_system_resource` | `finish_reason` 为此值 | 服务端瞬时资源不足 | 指数退避重试（1s → 2s → 4s） |
| 空回复 | `content` 为空且无 tool_calls | 偶发 | 重试一次；仍空则降级为「模型暂时无法响应」提示 |
| 多轮失忆 | 第 N 轮不调工具直接编答案 | 无 | 检查历史是否丢了 tool_calls/tool 消息；成对补回 |

---

## 7. References

### 官方文档（一手）
- [Tool Calls Guide](https://api-docs.deepseek.com/guides/tool_calls) — strict 模式、支持的 schema 类型、示例
- [Create Chat Completion API Reference](https://api-docs.deepseek.com/api/create-chat-completion) — tools/tool_choice/tool_calls 字段定义、arguments 合法性警告
- [Thinking Mode Guide](https://api-docs.deepseek.com/guides/thinking_mode) — 思考模式工具调用、reasoning_content 回传规则、400 错误
- [Thinking Mode Tool Call Sample](https://api-docs.deepseek.com/api_samples/thinking_mode_api_example_tool_call) — 多轮工具调用完整代码
- [JSON Output Guide](https://api-docs.deepseek.com/guides/json_mode) — response_format 约束
- [Change Log / Updates](https://api-docs.deepseek.com/updates) — 模型版本演进（V3.1 引入 strict、V3.2 思考模式工具调用、V4 上线）
- [V3.1 Release Notes (2025-08-21)](https://api-docs.deepseek.com/news/news250821) — 「Strict Function Calling supported in Beta API」官方公告
- [Quick Start](https://api-docs.deepseek.com/) — base_url、模型名、SDK 集成
- [FAQ](https://api-docs.deepseek.com/faq) — LangChain 兼容、空行/keep-alive 处理

### 社区报告（二手，已评估可信度）
- [DeepSeek Function Calling 踩了三天坑（头条）](http://m.toutiao.com/group/7661503519517688355/) — tool_choice/多轮上下文/中文编码/temperature 影响等实操经验，可信度较高
- [WeClaw 第 61 篇：DSML 标记泄漏全链路排查（CSDN）](https://blog.csdn.net/weixin_44063643/article/details/161961832) — **DSML 泄漏 Bug 的 hex 级实证**，含真实会话样本与 10/10 测试用例，可信度高
- [DeepSeek Function calling 响应模式：并行工具调用（CSDN）](https://blog.csdn.net/yang2330648064/article/details/149810426) — 并行多 tool_calls 实测示例
- [DeepSeek API 迁移指南（IndieSeek）](https://www.cnblogs.com/indieseek/p/21640551/deepseek-v4-api-migration-legacy-models) — 旧模型名迁移、多轮工具调用测试建议
- [工具调用失效？DeepSeek 未公开的 3 个隐式约束（CSDN）](https://blog.csdn.net/PoliSeed/article/details/161365149) — **可信度低**：声称引用 DeepSeek Go 源码（DeepSeek 非开源，系虚构）；tool_choice 索引对齐、nullable 强制等论断未获其他来源佐证，仅作存疑参考
- [DeepSeek V3.1 技术突破分析（掘金）](https://juejin.cn/post/7542709795423797275) — V3.1 新增 strict 模式的二手报道

### 相关 Ticket
- [R1 调研任务](https://github.com/CatInRl/Murasaki/issues/6) — 本调研的发起 ticket
- [T9 Provider 抽象](https://github.com/CatInRl/Murasaki/issues/12) — 本调研直接 informing 的实现 ticket
- [T1 循环架构](https://github.com/CatInRl/Murasaki/issues/2) — 多轮工具调用循环架构
