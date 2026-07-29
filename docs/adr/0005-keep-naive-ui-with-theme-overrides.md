# ADR 0005: 保留 naive-ui + themeOverrides 对齐 token

## 状态

已接受

## 背景

当前实现深度依赖 naive-ui（NModal/NButton/NInput/NSelect/NDropdown/NEmpty/NSpin/NRadio/NAlert/NTag 等遍布所有组件）。0.3.0 的设计系统定义了纯 token 化 + 语义类回退体系（`--murasaki-*` token），与 naive-ui 的样式 API 是两套并行系统。

调研发现的关键矛盾：
- [ConflictDialog.vue](../../src/components/ConflictDialog.vue) 用 NModal+NButton，视觉结构与设计不一致
- [CompareWindow.vue](../../src/components/CompareWindow.vue) 16 处硬编码颜色，绕过 token 体系
- [TreeNode.vue](../../src/components/TreeNode.vue) 用 NDropdown，hover 配色未对齐设计
- [FileTree.vue](../../src/components/FileTree.vue) 用 NEmpty，无 48px 图标无边框容器
- [SearchPanel.vue](../../src/components/SearchPanel.vue) 悬停绿色、高亮黄色，与紫色语义完全不符

## 决策

**保留 naive-ui**，通过 `NConfigProvider` + `themeOverrides` 把 naive-ui 的颜色/圆角/字体变量映射到 `--murasaki-*` token。保留 naive-ui 的组件能力（可访问性/键盘导航/焦点管理等），样式逐步对齐。

## 理由

1. **完全移除成本过高** —— naive-ui 提供的可访问性（ARIA/键盘导航）、焦点陷阱（NModal）、表单校验、虚拟滚动等成熟能力，自建要么做不好要么成本巨大。0.3.0 是 UX 对齐迭代，不是组件库重写迭代。
2. **themeOverrides 机制足够强大** —— 通过 `common: { primaryColor, borderRadius, fontFamily }` + 各组件的 `overrides`，可以把 naive-ui 的视觉变量映射到 `--murasaki-*` token。一次配置全局生效。
3. **保留单一组件库** —— 避免"两套组件系统并存"的认知负担（开发者需判断"这个组件该用 naive-ui 还是自建"）。
4. **设计系统的 token 仍能落地** —— themeOverrides 把 naive-ui 的色板锚定到 `--murasaki-*`，所有 naive-ui 组件的视觉输出自动跟随 token。
5. **硬编码颜色的清理与 token 化是独立工作** —— [CompareWindow.vue](../../src/components/CompareWindow.vue) 的 16 处硬编码、[SearchPanel.vue](../../src/components/SearchPanel.vue) 的黄绿色，无论选哪个方案都要清理，不是 naive-ui 本身的问题。

## 备选方案

**完全移除 naive-ui，全部自建 token 化组件** —— 用 `<dialog>`/原生 `<button>`/`<input>` + 语义类重写所有组件。被否决：工作量巨大（重写 20+ 组件），失去 naive-ui 的可访问性/键盘导航/焦点管理等成熟实现。

**混合策略（naive-ui 仅用于复杂组件，简单组件自建）** —— 保留 naive-ui 的 NModal/NSelect/NDropdown/NTabs 等复杂组件，自建 Button/Input/Empty/Toast/ContextMenu/EmptyState 等。被否决：两套组件系统并存的心智负担大，且需判断"该用哪个"。

## 后果

**正面**
- 保留 naive-ui 的成熟能力（可访问性、焦点管理、虚拟滚动等）。
- 一次 themeOverrides 配置全局生效，token 化对齐成本低。
- 工作量可控，0.3.0 可在合理时间内完成。

**负面**
- 某些组件视觉结构与设计差异较大（如 NEmpty vs 设计的"48px 图标+边框容器+操作按钮"），themeOverrides 改不了结构，仍需自建 wrapper 组件或用 slot 自定义。
- 部分组件（如 NDropdown 的菜单项 hover 配色）可能需要覆盖较深的 naive-ui 内部样式，需逐个验证。

## 实施边界

- **保留 naive-ui 默认行为**：NModal 的焦点陷阱、NSelect 的虚拟滚动、NDropdown 的点击外部关闭、NTabs 的键盘导航等**行为**保留。
- **视觉通过 themeOverrides 对齐**：颜色/圆角/字体/阴影映射到 `--murasaki-*` token。
- **部分组件自建 wrapper**：吐司/对话框/右键菜单/空态/错误态/加载态等与设计差异大的组件自建（见 ADR-0004 ~ 0007 相关议题簇决策），naive-ui 仅作为复杂组件（NPopover/NSelect/NTabs 等）的来源。
