# 设计系统与反馈组件（实现说明）

> 从 [CONTEXT.md](../CONTEXT.md) 下沉的实现细节（#447）。CONTEXT 只保留术语，
> 具体 token、组件与写法在这里维护。
> 相关 ADR：[0004](../adr/0004-lucide-vue-next-as-unified-icon-library.md)（图标库）、
> [0005](../adr/0005-keep-naive-ui-with-theme-overrides.md)（naive-ui 主题化）、
> [0006](../adr/0006-no-tailwind-keep-scoped-css.md)（不引入 Tailwind）。

## 设计 Token 体系

0.3.0 整体 UX 对齐引入的设计系统基础设施。参考设计稿位于 `murasaki-ui-design/`。

三层 token 体系（来自 `murasaki-ui-design/colors_and_type.css` + `.preflight/preflight.html`）：

- **Token 层**：`--murasaki-*` 语义 token（primary/popover/card/muted/border/ring/state-* 等）+ 尺寸 token（radius-sm/md/lg = 4/8/16px）
- **Tailwind 映射层**：`@theme inline` 把 token 映射为 Tailwind 4 的 `--color-*`（仅设计稿用，实现不引入 Tailwind，详见 ADR-0006）
- **语义类回退层**：即便 Tailwind JIT 未编译，`.bg-popover`/`.text-foreground` 等 CSS 类仍生效

0.3.0 token 补全（在 [theme.css](../src/styles/theme.css)）：

- 字号 token：`--murasaki-text-xs/sm/base/lg/xl/2xl`（12/13/14/16/20/24px）
- 阴影 token：`--murasaki-shadow-sm/md/lg/2`
- 布局 token：`--murasaki-menubar-height`（32px，仅设计参考用，应用内不实现 in-app menu bar，详见 ADR-0007）
- 过渡 token：`--murasaki-transition-fast`（120ms ease）

间距/字重/行高保留硬编码（不 token 化，避免 token 膨胀）。

## 设计系统与配色 (Design Tokens & Color)

0.9.x 起把配色收敛为「色阶 → 语义 token → 组件引用」三层（issue #293–#296），全部定义在 [theme.css](../src/styles/theme.css)。

- **色阶 (Palette)** —— 两族基础色，只定义一次、只被语义 token 引用：紫色阶 `--murasaki-purple-50…900`、中性阶 `--murasaki-neutral-50…950`。
- **语义 token (Semantic Tokens)** —— 能从色阶取值的逐项引用色阶（如 `--murasaki-primary: var(--murasaki-purple-600)`、`--murasaki-border: var(--murasaki-neutral-200)`），同一颜色只写一遍；色阶没有对应值、或不应进色阶的（纯白 `--murasaki-background`/`-popover`、`--murasaki-surface`/`-surface-2`、彩色底上的白 `--murasaki-primary-foreground`、状态四色 `--murasaki-state-success/warning/error/info`）保留字面值并就地注明。改一处色阶即改全套。
- **半透明覆盖层三档** —— 选中底 / hover 加深 / 焦点环统一由 `color-mix` 从主色派生，改主色自动跟随：`--murasaki-primary-soft`（12%）、`--murasaki-primary-soft-hover`（20%）、`--murasaki-primary-ring-soft`（30%）。例外：源码编辑器当前行底色比三档都淡，[SourceEditor.vue](../src/components/SourceEditor.vue) 就地写 `color-mix(in srgb, var(--murasaki-primary) 6%, transparent)` 保住视觉近等。
- **图表配色来源** —— Mermaid 的 `themeVariables`（[mermaidTheme.ts](../src/utils/mermaidTheme.ts)）、PlantUML 注入的最小 skinparam（[plantuml.ts](../src/utils/plantuml.ts)）、导出 HTML 的 `:root` token（[useHtmlExport.ts](../src/composables/useHtmlExport.ts)）都在**运行时**读 `getComputedStyle(document.documentElement)` 的 token 解析值，改主色即跟随；Mermaid 仍按需懒加载，分栏预览与 WYSIWYG 共用一个初始化入口（不再依赖「PreviewPane 先 initialize」的隐式副作用）。KaTeX 公式用主题内容色 `--md-fg`，不借用信息蓝。
- **硬编码政策** —— `src/**` 里引用的 `--murasaki-*` 必须在 `theme.css` 有定义、且不再带死 fallback，由 [tokenGuard.test.ts](../src/styles/tokenGuard.test.ts) 守卫（写错变量名即测试失败）；[useNaiveTheme.ts](../src/composables/useNaiveTheme.ts) 的 TS 常量与 `theme.css` 的一致性由单测逐项断言（引用关系，非字面值）；无法 token 化的判断类——第三方 token、`--md-*` 阅读主题特有值、装饰渐变——就地保留。

## 图标库 (Icon Library)

统一使用 **`lucide-vue-next`**（Vue 3 组件形式的 lucide 图标集），替换所有 emoji + 内联 SVG + naive-ui NIcon。详见 ADR-0004。

- 按需引入（tree-shakeable），常用图标约 30-50 个，总增量 <50KB gzip
- 与设计系统的 `[data-icon]` mask 模式语义 1:1 对应
- 跨平台渲染一致，可继承 currentColor，响应主题

## naive-ui 主题化策略 (naive-ui Theming)

保留 naive-ui 作为组件库，通过 `NConfigProvider` + `themeOverrides` 把 naive-ui 的颜色/圆角/字体变量映射到 `--murasaki-*` token。详见 ADR-0005。

- **保留 naive-ui 默认行为**：NModal 的焦点陷阱、NSelect 的虚拟滚动、NDropdown 的点击外部关闭、NTabs 的键盘导航等**行为**保留
- **视觉通过 themeOverrides 对齐**：颜色/圆角/字体/阴影映射到 `--murasaki-*` token
- **部分组件自建**：吐司/对话框/右键菜单/空态/错误态/加载态等与设计差异大的组件自建（全局 Pinia store + 单一 Teleport 容器 + Promise/数据驱动 API）

## 样式写法 (Styling Approach)

**不引入 Tailwind**，保留 scoped CSS + `--murasaki-*` token 变量。详见 ADR-0006。

- 与设计系统的**语义**对齐（颜色/圆角/间距数值一致），但**写法**不一致（设计用 Tailwind 工具类，实现用 scoped CSS）
- 翻译规则：`bg-primary/10` → `background: rgba(147, 51, 234, 0.1)` 或 `color-mix(in srgb, var(--murasaki-primary) 10%, transparent)`
- 硬编码颜色清理是独立工作（如 [CompareWindow.vue](../src/components/CompareWindow.vue) 的 16 处硬编码）

## 反馈系统组件模式 (Feedback System Pattern)

0.3.0 引入的反馈系统基础设施，统一模式：**全局 Pinia store + 单一 Teleport 容器 + Promise/数据驱动 API**，不依赖 naive-ui 的 NMessage/NDialog/NDropdown。

- **吐司系统**：`useToastStore` + `ToastContainer.vue`，6 变体（success/info/warning/error/progress/deleted），栈位置右上角
- **对话框系统**：`useDialogStore` + `DialogContainer.vue`，4 类型（alert/confirm/prompt/conflict），Promise-based API，按钮顺序"取消在左/确认在右"（与 naive-ui 默认相反），替换所有 36 处原生 `alert()/confirm()/prompt()`
- **右键菜单系统**：`useContextMenuStore` + `ContextMenuContainer.vue`，数据驱动（MenuItem 接口含 label/icon/shortcut/action/disabled/danger/separator），3 处右键菜单（TabBar/Editor/TreeNode）

## 状态展示组件家族 (State Display Component Family)

0.3.0 引入的状态展示组件三兄弟，共享虚线边框容器与 props 模式，替换 naive-ui 的 NEmpty/NSpin/NSkeleton：

- **EmptyState**：空态，lucide `w-12 h-12 text-muted-foreground/50` 图标 + 标题 + 描述 + 可选操作按钮
- **ErrorState**：错误态，lucide `alert-triangle` 黄色图标 + 标题 + 描述 + "重试"按钮
- **Skeleton**：加载态，`h-4 bg-muted rounded animate-pulse` 骨架条（默认 4 行，宽度递减 100%/90%/95%/70%）

## 浮层组件 (Popover)

用 naive-ui **NPopover + themeOverrides** 对齐 token（不自建）。详见 ADR-0005。

- 浮层是"纯容器"，NPopover 的视觉结构（圆角 + 边框 + 阴影 + 箭头）与设计规范一致，themeOverrides 足够对齐
- 内容由 slot 自定义（链接表单/图片插入表单/表格配置/UI 模式单选组等）
- trigger 统一用 `click`（hover 仅用于 tooltip，用 NTooltip）
