# ADR 0008: WYSIWYG 采用 CodeMirror 6 内实现（Typora 路线）

## 状态

已接受

## 背景

0.3.0 需实现 WYSIWYG（所见即所得）编辑模式。这是 0.3.0 三大重点之一（agent UX 提升 / 设置界面 UX / WYSIWYG 模式）。

WYSIWYG 模式有三种主流技术路线：

1. **CodeMirror 6 + markdown-it 双向同步（ProseMirror 路线）** —— 用 CodeMirror 6 的 ProseMirror 集成让 CM6 直接渲染富文本。
2. **双编辑器实例（CodeMirror 6 源码 + Tiptap/ProseMirror WYSIWYG）** —— 两个编辑器实例，通过 markdown 文本双向同步。
3. **CodeMirror 6 内 WYSIWYG（Typora 路线）** —— 单编辑器实例，markdown 文本为唯一数据源，通过 ViewPlugin decoration 隐藏/显示语法标记。

## 决策

采用 **CodeMirror 6 内 WYSIWYG（Typora 路线）**。

核心机制：
- 源文件始终是纯 markdown 文本（磁盘上就是 `# Hello **world**`）
- 编辑器渲染时：解析 markdown → 通过 ViewPlugin + Decoration **视觉隐藏**语法标记（`#`、`**`、`_`），显示渲染结果
- 光标触碰当前段时：语法标记重新显示为 dim 灰色，用户可编辑
- 光标离开当前段时：语法标记再次隐藏，显示纯渲染效果
- 源码模式用同一 CodeMirror 实例的纯文本编辑

## 理由

1. **Agent 原生兼容** —— Agent 生成的 `propose_insert`/`propose_replace` 在当前 CodeMirror 实例渲染，切换到 WYSIWYG 模式无需更换编辑器。Typora 路线直接消除"WYSIWYG 不支持 Agent 提案"问题。
2. **数据模型一致** —— Murasaki 的数据源始终是 `.md` 文件，不引入第二套文档模型（如 Tiptap 的 ProseMirror JSON），避免 markdown ↔ JSON 双向转换的边界问题。
3. **CodeMirror 6 完全复用** —— 现有 [EditorArea.vue](../../src/components/EditorArea.vue) 的 markdown 配置不动，WYSIWYG 只是一个 ViewPlugin 叠加层。
4. **三种模式运行时切换** —— `source`/`split`/`wysiwyg` 三种模式共用同一 CodeMirror 实例，全部运行时切换，无需重启。
5. **markdown 语法 100% 兼容** —— 源文件就是 markdown，不存在 Tiptap 的"自定义节点映射"问题。Mermaid/KaTeX/YAML/emoji 全部原生支持。
6. **Typora 的用户验证** —— Typora 是公认最流畅的 WYSIWYG markdown 编辑器，其技术路线已被市场验证。

## 备选方案

**CodeMirror 6 + markdown-it 双向同步（ProseMirror 路线）** —— 用 CodeMirror 6 的 ProseMirror 集成让 CM6 直接渲染富文本。被否决：CodeMirror 6 的 ProseMirror 集成是学术级复杂度，`@codemirror/lang-markdown` 不提供富文本渲染，需自定义 decoration 把 markdown 语法映射为富文本样式。0.3.0 时间线不允许。

**双编辑器实例（CodeMirror 6 源码 + Tiptap WYSIWYG）** —— 源码模式用现有 CM6，WYSIWYG 模式用 Tiptap（ProseMirror）。被否决：
- 双实例状态同步复杂（光标位置/选区/滚动/撤销栈）
- Tiptap 的 markdown 双向转换不是 100% 无损
- 引入 Tiptap 后 Agent 提案在 WYSIWYG 模式无法渲染（需切换源码模式）
- Tiptap 包体积（约 100KB+ gzip）
- Mermaid/YAML 等复杂语法需自定义 Tiptap 节点，工作量大

## 后果

**正面**
- Agent 提案在所有模式原生兼容（无需 Q7.2 的"WYSIWYG 不支持 Agent"裁剪）。
- 数据模型始终是纯 markdown 文本，无双向转换损耗。
- 三种模式（source/split/wysiwyg）共用同一 CodeMirror 实例，运行时切换，无需重启。
- 现有 CodeMirror 6 配置完全复用，WYSIWYG 只是叠加层。
- markdown 语法 100% 兼容，Mermaid/KaTeX/YAML/emoji 全部原生支持。

**负面**
- 需自定义 CodeMirror 6 ViewPlugin/Decoration 实现语法标记隐藏，技术挑战较高（特别是表格/代码块的语法标记处理）。
- 大文档（>10000 行）的 ViewPlugin 遍历性能需优化（增量更新，仅重计算可见区域 ± buffer）。
- `@codemirror/lang-markdown` 的语法树 token 类型是否足够标识所有语法标记需在实现前验证。

## 实施范围

### 三种编辑模式（共用同一 CodeMirror 实例）

- **source**：纯源码，无预览区（CodeMirror 6 占满编辑区）
- **split**：分屏，源码 + 预览（CodeMirror 6 + PreviewPane，`splitRatio` 可调）—— 默认模式
- **wysiwyg**：所见即所得（CodeMirror 6 + WYSIWYG ViewPlugin 隐藏语法标记，预览区隐藏）

### 模式切换

- `source` ↔ `split`：运行时切换（仅显隐预览区 + 调整布局）
- `wysiwyg` ↔ 其他：运行时切换（叠加/移除 WYSIWYG ViewPlugin）
- 不再需要"切换模式需重启"（修正 [CONTEXT.md:108](../../CONTEXT.md#L108) 的旧约定）

### WYSIWYG 功能优先级

- **P0（必须）**：行级语法标记隐藏 + 基础渲染（标题/粗体/斜体/删除线/行内代码/列表/引用/分隔线）
- **P1（应该）**：块级元素 widget（代码块/链接/图片/表格/数学公式/Mermaid）
- **P2/P3（遗留）**：YAML frontmatter 卡片 / emoji 短代码替换 / 脚注 / TOC / HTML 内联

### 光标行为

- 光标在当前段：所有标记可见（dim 灰色 + 缩小字号）+ 渲染样式保留
- 光标离开当前段：所有标记隐藏（`display: none` 或零宽替换）+ 渲染样式保留
- "当前段"定义：光标所在段落（空行分隔的连续文本行）

### 与 Agent 提案的优先级

Agent 提案 decoration（绿色 insert / 红色 strikethrough）优先级高于 WYSIWYG 隐藏 decoration。提案覆盖范围不隐藏语法标记（用户需看到原始 markdown 判断提案）。
