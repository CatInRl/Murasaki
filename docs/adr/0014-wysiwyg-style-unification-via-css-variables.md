# ADR-0014: WYSIWYG 样式与分栏预览统一（CSS 变量方案）

**日期**: 2026-08-03
**状态**: Accepted
**关联 Issue**: [#116](https://github.com/CatInRl/Murasaki/issues/116)、[#111](https://github.com/CatInRl/Murasaki/issues/111)、[#119](https://github.com/CatInRl/Murasaki/issues/119)

## 背景

Murasaki 有两套 Markdown 渲染路径：

1. **分栏预览**：markdown-it 生成 HTML，由 `--md-*` CSS 变量控制样式
2. **WYSIWYG**：CM6 StateField + Decoration，每个元素用 widget DOM 渲染，由 `wysiwygTheme`（CM6 扩展）控制样式

两套渲染引擎、两套 DOM 结构、两套 CSS，导致 WYSIWYG 模式视觉效果与分栏预览不一致。

## 决策

采用 **CSS 变量统一方案**（路径 A）：

- 不改渲染引擎，保持 WYSIWYG 用 CM6 widget 逐元素渲染
- WYSIWYG widget 的 DOM 结构对齐 markdown-it 生成的 HTML class 命名
- 两个模式共享同一套 `--md-*` CSS 变量
- 默认字体统一：编辑区用 JetBrains Mono 系，预览区/WYSIWYG 用霞鹜文楷 + Noto Sans SC

## 备选方案

### 路径 B：WYSIWYG 复用 markdown-it HTML

在 widget 内部直接用 markdown-it 渲染 HTML。

- **否决原因**：CM6 Decoration 与 innerHTML 混用会导致光标行为异常，性能风险高。当前 widget 方案已经可以逐元素渲染，只需对齐样式即可。

## 影响

- WYSIWYG widget 的 `toDOM()` 方法需要调整 class 命名以匹配 markdown-it 输出
- `wysiwygTheme` 中的样式规则迁移到共享 CSS 变量
- `--md-*` 变量需覆盖 WYSIWYG 场景（如编辑区内的行高、内边距）
- 任务列表（#119）和字体（#111）在此统一过程中一并解决
