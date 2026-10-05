# ADR 0021: MCP 知识库的 sidecar 形态、stdio 传输与磁盘索引

## 状态

已接受

## 背景

wayfinder 图 [#323](https://github.com/CatInRl/Murasaki/issues/323) 确定了产品方向：把 Murasaki 的工作区作为知识库暴露给外部 MCP 客户端（Trae / Claude Desktop / Cursor 等），提供「语义 + 关键词」混合检索。#264 已删除内置 agent 与云端 AI 能力，所以这是一个**只读、离线、外部消费**的检索出口，不涉及应用内 agent。

三张调研票（#324/#325/#326）的关键事实约束了设计空间：

- 应用进程被 single-instance 插件占用：第二个实例启动时会把路径转发给第一实例然后退出，「复用应用进程当服务端」会与之冲突；
- GUI 没有无窗口模式的先例，headless 化等于拉起整个前端运行时；
- 现有 `search_workspace` 只扫 `.md` 且只做关键词匹配，markdown 渲染全部在前端；
- drafts 落盘 `%APPDATA%\murasaki\drafts\`，草稿 mtime 可与磁盘文件比对（支撑 `stale_draft` 标注）；
- 嵌入模型体积（bge-m3 int8 约 558MB）不可能进安装包。

七张决策票（#327–#332、#334）的结论由本 ADR 固化。完整接口签名、数据模型与单测清单见 [spec](../specs/mcp-knowledge-base-spec.md)——本 ADR 只写**架构取舍**，两处表格不重复维护。

## 决策

### 1. sidecar 独立二进制，不复用应用进程

新增 `murasaki-mcp` 独立二进制（console 子系统），由 MCP 客户端按工作区各自 spawn。检索核心抽共用 crate `murasaki-kb`，GUI（写索引）与 sidecar（读索引）链接同一份实现。

**sidecar 是唯一同时满足三个约束的形态**（#327）：

- **single-instance 冲突**：把服务端塞进应用进程，客户端就得「先拉起应用」，而 second-instance 回调会把这次启动当作用户开文件转发给已有实例——服务端激活与应用激活两条语义打架；
- **无窗口 GUI 不可行**：Tauri 应用 headless 化要绕过窗口创建、webview 初始化、前端加载，没有先例且脆弱；
- **编辑器不开也能用**：sidecar 直接读磁盘索引，GUI 进程死活无关（索引缺失时 sidecar 自己同步懒建兜底）。

### 2. 传输走 stdio，不做 HTTP

MCP 客户端原生支持 stdio transport：spawn 子进程、stdin/stdout 收发 JSON-RPC 帧。父子进程直连**没有网络监听面**，因此**无认证设计**（#331）——不引入 token、端口管理、跨进程发现这些问题。协议采用 2026-07-28 无状态版规范：无 initialize/session 握手，能力走每请求 `_meta`；stdout 只跑协议帧，日志走 stderr；stdin EOF 是唯一可移植的关闭信号（serve until EOF → 退出，崩溃由客户端重连拉起）。

### 3. 一实例 = 一工作区

`murasaki-mcp --workspace <path>`，缺省取 `recent.json` 最近工作区。同一工作区多窗口仍是一个（canonicalPath 归一）。不做跨工作区合成索引（#323 Out of scope）——多工作区用户在客户端给每个工作区各配一个 server 条目即可，与「一窗口 = 一工作区」的应用语义同构。

### 4. 索引放 %APPDATA%，不进工作区

`%APPDATA%\murasaki\index\<workspace_key>\`，`workspace_key = sha1(规范化路径)`（复用 `sha1_hex()`，与 drafts 同款命名，规避路径非法字符）。

**不进工作区**的理由（#332）：索引文件会污染项目——git status 噪音、用户困惑「这是什么目录」，且用户的 `.gitignore` 不一定忽略它。`%APPDATA%` 集中还有附带好处：卸载清理有单一位置。

代价与对策：

- **工作区改名/移动 = 新 key = 重建**（大工作区重建分钟级，可接受——改名不频繁，且重建是后台任务）；
- 工作区在应用内移除**不**连带删索引（重新打开直接复用）；
- 写入一律临时文件 + rename 原子替换，崩溃时旧索引完好；
- 版本三元组（schema_version + embedder_id + chunker_version）任一失配 → 整体重建；
- 同工作区**单 writer**（GUI 内按 key 的 Mutex），sidecar 只读。

### 5. 嵌入选 ort + bge-m3 int8，模型首次使用时下载

- **运行时 `ort`**（ONNX Runtime 官方预编译）：随包附 `onnxruntime.dll` ~20MB，Windows / Linux x64 / macOS arm64 覆盖。
- **模型 bge-m3 int8**（1024 维 / MIT）：多语支持好，本项目用户以中文为主。
- **首次使用下载，不随安装包**：GitHub Release 自托管 + sha256 校验，URL/尺寸登记在前端常量 `modelManifest.ts`；下载由前端 fetch 流式 → fs plugin 写盘 → `crypto.subtle` 校验执行，零新增运行期依赖。
- **降级矩阵**（#334）：模型未下载 / 加载失败 / **macOS x64**（ORT 预编译停更，编译排除）→ 检索响应带 `degraded: "keyword-only"`，`search_workspace` 关键词通道独立可用；GUI 设置页停用 → `kb_disabled`。**降级是产品行为不是错误处理**：macOS x64 用户拿到的是「关键词检索」而不是「此平台不支持」。

### 6. 分块、生命周期、工具面不在 ADR 展开

分块规则（chunker_version=1）、生命周期表（GUI 预建 / sidecar 懒建 / 1.5s 防抖 diff / drafts 比对）、三个 MCP 工具（`search_knowledge` / `read_document` / `list_workspace`）的签名与预算（limit≤32 / 读≤400 行 / 响应≤16KB）——这些是**规格细节**而非架构取舍，见 spec 对应章节，本 ADR 不复制（两处表格必然漂移）。

## 理由

1. **三个约束各自排除掉一个备选**（决策 ①）——剩下的形态自然收敛，不需要再权衡。
2. **stdio 的零认证面是安全上的净收益**——HTTP server 意味着端口暴露与认证设计；stdio 意味着「能跟服务端说话的只有 spawn 它的客户端」，攻击面从「网络」缩到「本机进程关系」。
3. **索引出工作区是产品判断不是技术妥协**（决策 ④）——用户的工作区是他们的文档，Murasaki 不该往里塞机器文件。
4. **共用 crate 而不是两份实现**——GUI 写索引、sidecar 读索引，分块/嵌入/检索逻辑一旦分叉，两边对同一工作区的理解就不一致（检索结果对不上索引内容）。一份 crate 是对齐的最低成本。
5. **模型下载链路零新增依赖**——前端已有 fetch / fs plugin / crypto.subtle，不必为此引入下载器 crate。

## 备选方案

**复用应用进程做 MCP server（tauri 命令面 + 自定义 IPC）** —— 被否决：single-instance 冲突（见决策 ①）；且客户端生态（Trae / Claude Desktop）的配置模型是 `command + args`，期望一个可执行文件，不是「先开 GUI」。

**HTTP transport（localhost + 端口）** —— 被否决：认证、端口冲突、多实例发现全是新增问题，而收益（跨机访问）不存在——知识库消费的就是本机工作区。

**索引放工作区内（如 `.murasaki/` 目录）** —— 被否决：见决策 ④。好处（改名/移动索引跟着走）不值得污染代价。

**fastembed（WASM）/ candle** —— 被否决：fastembed 走 WASM 推理慢一个量级；candle 无预编译二进制、Rust 编译慢、算子覆盖不全。若 ort 路线将来遇阻可重新评估 candle（纯 Rust、无预编译依赖的另一面是可控）。

**模型随安装包分发** —— 被否决：558MB 让安装包体积涨 30 倍，而多数用户未必使用外部 MCP 客户端；首次使用下载把成本放在「确实要用的人」身上。

## 后果

**正面**

- 「外部工具检索工作区」有了一个不依赖 GUI 生命周期的稳定出口：编辑器关着，agent 也能查。
- 检索核心（分块/嵌入/索引/检索）收敛为单一 crate，后续加工具或改算法只有一处。
- 安全模型简单到可以一句话说完：无网络监听、严格只读、严格限工作区。

**负面**

- 新增一个随包分发的二进制：`tauri.conf.json` externalBin、CI 构建矩阵、发布产物体积都要跟上。
- 模型清单（URL/sha256/尺寸）是前端常量，模型换版要发前端改动；设置页热更新模型清单当前不做。
- macOS x64 永久降级为关键词检索；ORT 上游若恢复 macOS x64 预编译可解除。
- 索引在 %APPDATA%：工作区改名/移动后首次检索走懒建同步（300 块 ≈ 20–30s，R2 基线），期间无语义结果。

## 实施边界

### 文件改动

- spec：[docs/specs/mcp-knowledge-base-spec.md](../specs/mcp-knowledge-base-spec.md)（接口/数据模型/单测清单/验收标准的单一事实源）
- crate：`src-tauri/crates/murasaki-kb/`（chunker / embedder / index_store / search / outline）、`src-tauri/crates/murasaki-mcp/`（sidecar main）
- GUI 侧：`src-tauri/src/kb_manager.rs`（生命周期）、`src-tauri/src/commands/kb.rs`（设置页命令）
- 前端：`src/config/modelManifest.ts`、设置页「知识库」分区
- 配置：`src-tauri/Cargo.toml`（升级 workspace 根）、`src-tauri/tauri.conf.json`（externalBin += murasaki-mcp）

### 测试

- 见 spec 单测清单（8 组：chunker / search / index_store / embedder / kb 安全 / mcp 帧 / read_document / 生命周期）
- `parse_outline_str` 抽入 crate 后原 Rust 测试全量保留（行为不变的护航）

### 范围外

- 应用内 agent / LLM / BYOK（#264 已删，不回来）
- 写操作（sidecar 对工作区严格只读）
- MCP 之外的第二个入口、检索质量评测集（#323 Not yet specified，另票处理）
- 跨工作区合成索引
