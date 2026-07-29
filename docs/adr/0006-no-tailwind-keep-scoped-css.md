# ADR 0006: 不引入 Tailwind，保留 scoped CSS

## 状态

已接受

## 背景

参考设计系统（`murasaki-ui-design/.preflight/preflight.html`）使用 Tailwind 4（`@tailwindcss/browser@4.3.1` CDN + `@theme inline` 映射 + `semantic-token-fallback`）。设计页面大量使用 Tailwind 工具类（`bg-primary/10 text-primary px-3 py-2 rounded-md` 等）。

当前实现**未引入 Tailwind**，全部用 scoped CSS + `--murasaki-*` token 变量。两种写法并存：

设计页（Tailwind）：
```html
<button class="bg-primary text-primary-foreground hover:bg-primary/90 px-3 py-1.5 text-sm rounded-md">
```

当前实现（scoped CSS）：
```css
.btn-primary {
  background: var(--murasaki-primary);
  color: var(--murasaki-primary-foreground);
  padding: 6px 12px;
  border-radius: var(--murasaki-radius-md);
}
```

## 决策

**不引入 Tailwind**，保留 scoped CSS + `--murasaki-*` token 变量。新组件按设计 token 手写 CSS 类，与设计系统的**语义**对齐（颜色/圆角/间距数值一致），但**写法**不一致（设计用工具类，实现用手写类）。

## 理由

1. **避免技术栈膨胀** —— 当前项目用 naive-ui + scoped CSS，引入 Tailwind 是第三套样式系统。ADR-0005 已决定保留 naive-ui，再加 Tailwind 会让样式来源更复杂（naive-ui CSS-in-JS + scoped CSS + Tailwind 原子类三套）。
2. **scoped CSS 与设计的语义对齐已足够** —— 设计系统定义的是 token 层（颜色/圆角/间距数值），scoped CSS 通过 `var(--murasaki-*)` 完全可以引用这些 token。`bg-primary/10` 在 scoped CSS 里写成 `background: rgba(147, 51, 234, 0.1)` 或 `color-mix(in srgb, var(--murasaki-primary) 10%, transparent)`，视觉结果一致。
3. **Tailwind 工具类不是设计系统的本质** —— 设计系统的本质是 token 体系 + 组件视觉规范，Tailwind 只是设计页面用的"写法"。实现侧用 scoped CSS 引用相同 token，落地的视觉一致，只是写法不同。
4. **Vue 3 + scoped CSS 是成熟模式** —— 当前实现已有完整的 scoped CSS 体系，迁移成本高且收益有限。Tailwind 的"开发效率高"在已有 scoped CSS 体系的项目里不成立——反而要维护两套样式写法。
5. **设计页面用 Tailwind 是"设计稿写法"** —— 设计页面用 Tailwind CDN 是为了快速出稿 + 验证 token 体系，不代表实现必须用 Tailwind。`semantic-token-fallback` 的存在恰恰说明设计系统关注的是"语义类是否生效"，而非"是否用 Tailwind"。
6. **naive-ui 共存约束** —— Tailwind preflight reset 会清掉 naive-ui button 等默认样式，需配 `preflight: false`，失去 reset 优势。naive-ui 官方不推荐与 Tailwind preflight 共存。

## 备选方案

**引入 Tailwind 4（与设计一致）** —— 在 Vue 项目中引入 `tailwindcss` + `@tailwindcss/vite` 插件，配置 `@theme inline` 映射 `--murasaki-*` token。被否决：技术栈膨胀 + naive-ui 共存冲突 + 已有 scoped CSS 体系迁移成本高。

**引入 Tailwind，但仅用于新组件，旧组件保留**（渐进迁移）—— 被否决：两套样式写法并存增加维护负担。

## 后果

**正面**
- 样式系统数量可控（naive-ui CSS-in-JS + scoped CSS 两套）。
- 无 naive-ui 共存冲突。
- 已有 scoped CSS 体系不动，迁移成本为零。

**负面**
- 间距/字号 token 化程度不足。设计页用 Tailwind 的标准尺寸（`text-sm`=13px、`px-3`=12px、`py-1.5`=6px 等），当前 [theme.css](../../src/styles/theme.css) 只定义了颜色/圆角/几个尺寸 token，间距/字号 token 缺失。需补全（见 Q0.4 token 补全决策）。
- 部分复杂选择器（如 `hover:bg-primary/90`）在 scoped CSS 里写起来较啰嗦，但可接受。
- 每次"翻译"设计稿的 Tailwind 类名到 scoped CSS 是持续的小成本。

## 实施边界

- **token 语义对齐是硬约束**：无论用哪种写法，颜色必须用 `--murasaki-*` token，圆角必须用 `--murasaki-radius-*`。
- **硬编码颜色清理是独立工作**：[CompareWindow.vue](../../src/components/CompareWindow.vue) 的 16 处 `#e8e8e8/#fafafa/#24292e/#d4f4dd/#ffe0e0` 都要替换为 `--murasaki-*` token。
- **设计页作为"视觉规格参考"而非"代码模板"**：实现时参考设计页的 token 用法与视觉结构，但不直接复制 Tailwind 类名。
- **翻译规则**：`bg-primary/10` → `background: rgba(147, 51, 234, 0.1)` 或 `color-mix(in srgb, var(--murasaki-primary) 10%, transparent)`。
