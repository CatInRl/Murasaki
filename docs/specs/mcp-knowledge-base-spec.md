# MCP 工作区知识库（只读检索服务端）— 实现规格

> 来源：wayfinder 图 [#323](https://github.com/CatInRl/Murasaki/issues/323)；决策票 [#327](https://github.com/CatInRl/Murasaki/issues/327)（形态/传输/路由）、[#328](https://github.com/CatInRl/Murasaki/issues/328)（原语/接口）、[#329](https://github.com/CatInRl/Murasaki/issues/329)（分块）、[#330](https://github.com/CatInRl/Murasaki/issues/330)（生命周期）、[#331](https://github.com/CatInRl/Murasaki/issues/331)（权限/可见性）、[#332](https://github.com/CatInRl/Murasaki/issues/332)（存储）、[#334](https://github.com/CatInRl/Murasaki/issues/334)（嵌入）。架构取舍见 [ADR-0021](../adr/0021-mcp-knowledge-base-sidecar-stdio-and-disk-index.md)。

## Problem Statement

外部 AI 编码工具（Trae / Claude Desktop / Cursor 等 MCP 客户端）无法把 Murasaki 的工作区当作知识库来检索：agent 只能靠文件系统全量翻找，缺少「语义 + 关键词」混合检索、结构化分块与片段定位。应用在 #264 已删除内置 agent 与云端 AI 能力，需要一个**只读、离线、外部消费**的检索出口。

## Solution

新增 **stdio MCP 服务端 sidecar（`murasaki-mcp`）** 与 **检索核心 crate（`murasaki-kb`）**：GUI 打开工作区时后台构建磁盘索引（markdown 结构化分块 + bge-m3 int8 本地嵌入）；sidecar 由 MCP 客户端按工作区各自 spawn，直接读盘提供 `search_knowledge` / `read_document` / `list_workspace` 三个只读工具。模型未就绪或平台不支持时降级为关键词检索（复用 `search_workspace` 通道），知识库功能不断崖。

## 架构总览

```
MCP 客户端 ──spawn──▶ murasaki-mcp (sidecar, stdio, 一实例=一工作区)
                          │ 直接读盘（不依赖 GUI 进程）
                          ▼
   %APPDATA%\murasaki\index\<workspace_key>\   ← murasaki-kb 写入
   %APPDATA%\murasaki\models\bge-m3-int8\      ← GUI 侧下载

Murasaki GUI (src-tauri) ──链接──▶ murasaki-kb
   打开工作区 → 后台预建/续建索引（单 writer）
   WatcherState 事件 → 1.5s 防抖 → 增量更新
```

- **一实例 = 一工作区**：`murasaki-mcp --workspace <path>`，缺省取 `recent.json` 最近工作区；同工作区多窗口仍是一个（canonicalPath 归一）；无有效工作区返回 `workspace_not_found` 错误，不退出。
- **生命周期**：客户端 spawn → serve until stdin EOF → 退出；崩溃由客户端重连拉起；与 single-instance 插件零交互（独立二进制，不复用应用进程）。

## 接口签名

### MCP 工具面（协议：JSON-RPC 2.0 over stdio，2026-07-28 无状态版规范——无 initialize/session，能力走每请求 `_meta`）

#### `search_knowledge`

```jsonc
// 请求
{ "query": string, "limit"?: number /* 默认 8，上限 32 */,
  "path_prefix"?: string, "with_context"?: boolean /* 默认 false */ }
// 响应
{ "results": [ { "path": string,            // 工作区内相对路径（/ 分隔）
                 "heading_trail": string[],  // 面包屑标题链，如 ["指南","安装"]
                 "line_range": [number, number],
                 "score": number,            // RRF 融合分
                 "snippet": string,          // ≤512 token，with_context 时为整节
                 "stale_draft"?: true } ],   // 存在未保存草稿时标注
  "degraded"?: "keyword-only",  // 模型未下载/加载失败/macOS x64
  "total_blocks": number,
  "truncated": boolean }         // 响应体超 16KB 截断标记
```

#### `read_document`

```jsonc
// 请求
{ "path": string, "offset_line"?: number /* 默认 1 */, "limit_lines"?: number /* 默认 400 */ }
// 响应
{ "content": string, "total_lines": number, "has_more": boolean }
```

#### `list_workspace`

```jsonc
// 请求
{ "sub_path"?: string }   // 缺省 = 工作区根
// 响应
{ "entries": [ { "name": string, "type": "file"|"dir", "children_count"?: number } ],
  "outline"?: { "level": number, "text": string, "line": number }[] }  // 仅 sub_path 为 .md 文件时
```

错误约定：路径越界 → `path_outside_workspace`；停用 → `kb_disabled`；工作区无效 → `workspace_not_found`；忽略规则内路径（`.git`/`node_modules` 等）视为不存在。

### Rust crate 接口（`murasaki-kb`）

```rust
// chunker.rs —— 纯函数，无 IO
pub fn chunk_markdown(source: &str) -> Vec<Chunk>;

// embedder.rs —— ort 运行时封装
pub struct Embedder;
impl Embedder {
    pub fn load(model_dir: &Path) -> Result<Embedder, KbError>;
    pub fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, KbError>;
}

// index_store.rs —— 磁盘读写，全部原子替换
pub struct IndexStore { /* dir: index/<workspace_key>/ */ }
impl IndexStore {
    pub fn open(workspace_path: &Path) -> Result<IndexStore, KbError>; // key = sha1(canonical)
    pub fn load_meta(&self) -> Option<IndexMeta>;
    pub fn write(&self, meta: &IndexMeta, chunks: &[Chunk], vectors: &[Vec<f32>]) -> Result<(), KbError>;
    pub fn read(&self) -> Result<(IndexMeta, Vec<Chunk>, Vec<Vec<f32>>), KbError>;
}

// search.rs —— 纯函数（向量部分）
pub fn cosine_top_k(query: &[f32], vectors: &[Vec<f32>], k: usize) -> Vec<(usize, f32)>;
pub fn rrf_fuse(keyword: Vec<Scored>, semantic: Vec<Scored>, k: usize = 60) -> Vec<Scored>;

// lib.rs
pub enum KbError { ModelMissing, PlatformUnsupported, Io(std::io::Error),
                   InvalidWorkspace, Disabled, ... }
pub fn workspace_key(workspace_path: &Path) -> String; // 复用 sha1_hex()
pub fn is_version_match(meta: &IndexMeta) -> bool;     // 三元组比对
```

`IndexMeta`：

```jsonc
{ "workspace_path": string,        // 人类可读原文路径
  "schema_version": number,        // 索引布局版本
  "embedder_id": string,           // 如 "bge-m3-int8@1"
  "chunker_version": number,       // 分块规则版本
  "block_count": number,
  "created_at": string, "updated_at": string }
```

`Chunk`：`{ chunk_id, file_path, heading_trail: Vec<String>, line_start, line_end, content, title: Option<String>, tags: Vec<String> }`。

## 数据模型与磁盘布局

```
%APPDATA%\murasaki\
├── index\<workspace_key>\        # workspace_key = sha1(规范化工作区路径)
│   ├── meta.json                 # IndexMeta（如上）
│   ├── chunks.json               # Chunk 数组（行号/标题链/正文）
│   └── vectors.bin               # f32 小端连排，1024 维/块；int8 量化时为 i8 + scale
└── models\bge-m3-int8\           # 首次使用下载（model.onnx + tokenizer + sha256 已验）
```

- 写入一律 **临时文件 + rename 原子替换**；崩溃时旧索引完好。
- 版本三元组（schema_version + embedder_id + chunker_version）任一不匹配 → 整体重建。
- 工作区改名/移动 = 新 key = 重建；工作区移除**不**连带删索引。

## 分块规则（chunker_version = 1）

- **主边界**：ATX 标题 h1–h3 开启新块；段落/列表/引用在块内延续。
- **整体成块**：围栏代码块、表格不内部切；超 1024 token 才按行硬切（表格切片重复表头、代码切片保留围栏与语言标注）。
- **大小**：目标 ~512 token，硬区间 [128, 1024]；尾块 <128 token 并入前一邻居；**不重叠**。
- **frontmatter**：不单独成块，解析出 `title`/`tags` 并入首块元数据。
- **范围**：仅工作区内 `.md`，忽略规则与文件树一致（`.git`/`node_modules` 等）。

## 生命周期

| 场景 | 行为 |
|---|---|
| GUI 打开工作区 | 后台空闲线程检查 `index/<key>/meta.json` → 缺失/版本失配 → 全量预建（不阻塞 UI） |
| sidecar 首查无索引 | 同步建完再答，响应带 `total_blocks`（R2 基线：300 块 ≈ 20–30s） |
| 文件变更 | `WatcherState` 事件 → 1.5s 防抖 → mtime+size 全量 diff → 重写受影响文件块 → 原子替换 |
| 文件删除/重命名 | 防抖 diff 识别 → 对应块移除后重写 |
| 未保存编辑 | **不入索引**；`drafts/<sha1(path)>` 存在且 mtime 晚于磁盘文件 → 检索结果标 `stale_draft` |
| 模型升级 | `embedder_id` 变更 → 版本失配 → 后台重建 |
| 并发 | 同工作区单 writer（GUI 内按 key 的 Mutex）；sidecar 只读 |

## 嵌入与降级

- **运行时**：`ort`（官方预编译，随包附 `onnxruntime.dll` ~20MB；Windows/Linux x64/macOS arm64；**macOS x64 不支持**——ORT 预编译停更）。
- **模型**：bge-m3 int8（1024 维 / MIT）；**首次使用下载**，不随安装包；URL/sha256/尺寸登记在前端常量 `src/config/modelManifest.ts`，下载由**前端 fetch 流式 → fs plugin 写盘 → `crypto.subtle` SHA-256 校验**执行（零新增运行期依赖）。
- **降级矩阵**：模型未下载 / 加载失败 / macOS x64 → `degraded: "keyword-only"`（`search_workspace` 通道独立可用）；GUI 停用开关 → `kb_disabled`。

## 权限与安全

- stdio 父子进程直连，无网络监听面，**无认证设计**。
- 路径校验：canonicalPath 归一化 + 拒绝 `..` + 符号链接解析后必须仍在工作区内。
- 日志走 stderr（MCP 规范：stdout 仅协议帧），内容为查询词 + 命中数 + 耗时，**不含文档正文**。

## 落地文件定位

```
src-tauri/
├── Cargo.toml                      # 升级为 workspace 根：members += crates/*
├── crates/
│   ├── murasaki-kb/                # 检索核心 crate（GUI 与 sidecar 共用）
│   │   ├── src/lib.rs              #   KbError / workspace_key / 版本判定
│   │   ├── src/chunker.rs          #   分块（纯函数）
│   │   ├── src/embedder.rs         #   ort 封装（feature-gated，macOS x64 编译排除）
│   │   ├── src/index_store.rs      #   磁盘读写 + 原子替换
│   │   └── src/search.rs           #   cosine_top_k / rrf_fuse（纯函数）
│   └── murasaki-mcp/               # sidecar 二进制（console 子系统）
│       └── src/main.rs             #   args 解析 + 最小 JSON-RPC stdio 循环（手写帧解析，
│                                   #    无 async 运行时；协议面仅 3 工具，顺序处理请求）
├── src/
│   ├── kb_manager.rs               # GUI 侧生命周期：预建线程 / 防抖 diff / 单 writer
│   └── commands/kb.rs              # kb_status / kb_set_enabled / kb_clear（设置页用）
├── 依赖：ort（运行期，记 CHANGELOG）；
└── tauri.conf.json：bundle.externalBin += murasaki-mcp（随包分发 sidecar）

src/（前端）
├── config/modelManifest.ts         # 模型版本/URL/sha256 常量
└── 设置页「知识库」分区组件          # 状态 / 停用开关 / 清除索引 / 模型下载（进度 + 重试）
```

- `list_workspace` 的大纲复用 `parse_outline_str` 口径：解析逻辑从 commands 层抽入 `murasaki-kb`（`outline.rs`），原命令改为调用 crate（行为不变，测试护航）。
- `search_workspace` 关键词通道：从 `search.rs` 抽可复用查询函数入 `murasaki-kb`（GUI 命令与 sidecar 共用），返回结构映射进 `results`。

## 单测清单

| 模块 | 用例 |
|---|---|
| chunker | 标题边界开新块 / 代码块与表格整体成块 / 超 1024 按行硬切且表格重复表头 / 尾块 <128 并入邻居 / frontmatter 并入首块 / heading_trail 正确嵌套 |
| search | cosine_top_k 排序确定性 / rrf_fuse 两通道融合次序 / 空通道退化 |
| index_store | 版本三元组失配判定 / 原子替换（模拟写一半崩溃旧索引完好）/ workspace_key 归一化（反斜杠、尾斜杠、盘符大小写） |
| embedder | mock 向量下 embed 批量维度一致；`PlatformUnsupported`（macOS x64 常量路径）|
| kb（安全） | `..` 越界拒绝 / 符号链接逃逸拒绝 / 忽略规则内路径视为不存在 |
| mcp 帧 | 合法请求解析 / 畸形 JSON 返回协议错误不退出 / stdin EOF 干净退出 / stdout 无日志混入 |
| read_document | 分页边界（offset 超尾、limit 截断、has_more 判定）|
| 生命周期 | drafts mtime 比对标 stale_draft / 防抖 diff 删除块 |

前端：模型下载组件的 sha256 校验失败重试、降级提示态（vitest）；`parse_outline_str` 抽 crate 后原 Rust 测试全量保留通过。

## 验收标准（对照 #323 Destination）

1. Trae / Claude Desktop 以 `command: murasaki-mcp, args: ["--workspace", "<path>"]` 配置后，agent 能列出工作区结构、检索到语义相关片段并取回全文。
2. 编辑器**未打开**时 sidecar 独立可用（读磁盘索引 + 懒建兜底）。
3. 模型未下载/不支持平台上，检索仍返回关键词结果且带降级标记。
4. 路径越界、停用、无工作区均返回结构化错误，不崩溃不退出。
5. GUI 设置页可见索引状态并可控停用/清除。

## Out of scope（沿用 #323）

应用内 agent/LLM/BYOK；写操作；HTML 渲染或应用状态暴露面；云端嵌入；跨工作区合成索引。MCP 之外的第二个入口与检索质量评测集不在本 spec（见 #323 Not yet specified）。
