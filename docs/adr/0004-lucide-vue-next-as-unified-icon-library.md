# ADR 0004: 引入 lucide-vue-next 作为统一图标库

## 状态

已接受

## 背景

0.3.0 进行整体 UX 对齐，参考设计系统（`murasaki-ui-design/`）统一使用 lucide 图标集（通过 `[data-icon]` mask 渲染）。当前实现的图标来源混乱：

- 内联 SVG（如 [AgentPanel.vue](../../src/components/AgentPanel.vue) 的五角星、[WelcomePage.vue](../../src/components/WelcomePage.vue) 的 logo 盒）
- emoji 替代图标（[AgentPanel.vue](../../src/components/AgentPanel.vue) 大量使用 ⚠🗜🔧📄＋/↻✓/✗）
- naive-ui NIcon 组件（无统一图标集）
- 无图标（[TreeNode.vue](../../src/components/TreeNode.vue) 右键菜单项无图标）

这导致跨平台渲染不一致、无法继承 currentColor、无法响应主题、与设计系统语义脱节。

## 决策

引入 **`lucide-vue-next`** 作为统一图标库，替换所有 emoji + 内联 SVG + naive-ui NIcon。

## 理由

1. **设计系统对齐** —— 参考设计系统明确统一用 lucide，`lucide-vue-next` 是官方 Vue 3 组件，与设计语义 1:1 对应。
2. **emoji 替代图标是明确缺陷** —— 跨平台渲染不一致、无法继承 currentColor、无法响应主题。
3. **tree-shaking 友好** —— `lucide-vue-next` 按需引入，常用图标约 30-50 个，总增量 <50KB gzip。
4. **naive-ui NIcon 不提供图标集** —— 只是图标容器，仍需自带 SVG，等于绕一圈。
5. **后续 UX 对齐的前置依赖** —— 菜单项图标、空态图标、吐司图标、浮层图标、状态栏图标全部依赖统一图标库。

## 备选方案

**保留现状 + 按需引入**（渐进式迁移）—— 不统一图标库，新组件用 lucide-vue-next，旧组件保留。被否决：导致两套图标系统长期并存，维护负担更大。

**用 naive-ui NIcon + 自定义 SVG** —— 不引入新依赖，把 lucide SVG 路径塞进 NIcon。被否决：语义不清晰，且 naive-ui 的图标 API 与设计的 `[data-icon]` mask 模式不一致。

## 后果

**正面**
- 所有图标统一来源，视觉一致。
- 跨平台渲染一致，响应主题色。
- 与设计系统 1:1 对齐，降低设计→实现翻译成本。

**负面**
- 新增依赖（`lucide-vue-next`，但按需引入体积可控）。
- 现有 emoji + 内联 SVG 需逐一替换，机械工作量大。

## 实施范围

- 替换 [AgentPanel.vue](../../src/components/AgentPanel.vue) 的 emoji（⚠🗜🔧📄＋/↻✓/✗）
- 替换 [WelcomePage.vue](../../src/components/WelcomePage.vue) 的内联 SVG logo
- 替换 [TreeNode.vue](../../src/components/TreeNode.vue) 右键菜单项的无图标状态
- 后续所有新组件（吐司/对话框/右键菜单/空态/浮层等）统一使用 lucide-vue-next
