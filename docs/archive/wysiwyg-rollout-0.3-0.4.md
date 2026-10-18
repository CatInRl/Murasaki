# WYSIWYG 分期落地记录（0.3.0 / 0.4.0）

> 从 [CONTEXT.md](../../CONTEXT.md) 归档的历史计划（#447）。这些条目已全部完成，
> 只用于追溯「某个能力是哪一版补上的」。架构说明见 [ADR-0008](../adr/0008-wysiwyg-via-codemirror6-typora-approach.md)。

## 功能优先级（0.3.0）

- **P0（必须）**：行级语法标记隐藏 + 基础渲染（标题/粗体/斜体/删除线/行内代码/列表/引用/分隔线）
- **P1（应该）**：块级元素 widget（代码块/链接/图片/表格/数学公式/Mermaid）
- **P2/P3（遗留后续版本）**：YAML frontmatter 卡片 / emoji 短代码替换 / 脚注 / TOC / HTML 内联

## 补全项（0.4.0）

0.4.0 补齐 0.3.0 遗留的 P2/P3 项（除 TOC 移至 0.5.0）：

- **Emoji 短代码替换** —— WYSIWYG 模式下 `:smile:` 等短代码直接渲染为 emoji 字符（修改源码替换为 emoji 字符，非仅视觉隐藏）。详见 issue #99。
- **YAML frontmatter 卡片交互** —— frontmatter 渲染为卡片，点击切源码模式并定位到 frontmatter 起始行。详见 issue #100。
- **脚注定义原位渲染** —— `[^1]` 脚注定义在原位渲染为脚注列表项（而非文末汇聚），点击引用跳转。详见 issue #101。
- **内联 HTML 安全渲染** —— 通过 DOMPurify 净化 + 白名单标签渲染内联 HTML，防 XSS。详见 issue #103。
- **TOC 支持** —— 移至 0.5.0（当前已有大纲视图覆盖导航需求）。详见 issue #102。
