# ADR 0007: 保留 Tauri 原生菜单栏

## 状态

已接受

## 背景

参考设计页（`murasaki-ui-design/pages/main-editor.html`）画了一个 32px 高的应用内 in-app menu bar（含"Murasaki"品牌 + 文件/编辑/段落/主题/帮助菜单项，标题栏带 `-webkit-app-region: drag`）。

当前实现用 **Tauri 原生 OS 菜单栏**（[menu.rs:30-125](../../src-tauri/src/commands/menu.rs#L30) 构建了文件/编辑/段落/主题/帮助 5 个菜单，通过 `app.set_menu(menu)` 设置为 OS 菜单栏），而非设计页画的 in-app menu bar。

设计页的 grid 是 `32px 36px 1fr 24px`（menubar/tabbar/content/statusbar），当前实现的 grid 是 `36px 1fr 24px`（无 menubar）。

## 决策

**保留 Tauri 原生菜单栏**，不实现设计页的 32px in-app menu bar。应用内 grid 从 `32px 36px 1fr 24px` 简化为 `36px 1fr 24px`。

## 理由

1. **OS 原生菜单是 Tauri 应用的标准实践** —— Tauri 的设计哲学就是用 OS 原生组件减少 WebView 体积。原生菜单的键盘集成（Alt+F 打开文件菜单）、系统集成（macOS 顶部菜单栏）是 in-app menu bar 难以复刻的。
2. **设计页的 in-app menu bar 可能是设计稿的"视觉占位"** —— 设计页统一画了 32px 菜单栏是为了视觉完整性，但 Murasaki 是 Tauri 应用不是 Electron 应用，OS 原生菜单是更合理的选择。[CONTEXT.md:32-99](../../CONTEXT.md#L32) 已明确定义了完整的菜单结构，且实现侧 [menu.rs](../../src-tauri/src/commands/menu.rs) 已落地——这是已确定的架构决策，不应因设计稿的视觉表达而推翻。
3. **改为 in-app menu bar 工作量与风险不成比例** —— 重写 5 个菜单 + 最近打开子菜单 + 菜单事件路由 + 键盘集成，工作量大且容易引入回归。0.3.0 是 UX 对齐迭代，不是架构重构迭代。
4. **布局调整更简单** —— 保留 OS 原生菜单后，应用内 grid 简化为 `36px 1fr 24px`（tabbar/content/statusbar），与当前实现几乎一致，无需大改。
5. **品牌"Murasaki"的展示位置可另寻** —— 如果需要在应用内展示品牌，可在欢迎页、关于对话框、状态栏等位置展示，不必占用 32px 头部行。

## 备选方案

**改为应用内 in-app menu bar（对齐设计）** —— 移除 Tauri 原生菜单，用 Vue 实现 32px in-app menu bar。被否决：失去 OS 原生菜单的集成优势（Windows Alt 键聚焦、macOS 顶部菜单栏、系统菜单事件路由），且 [menu.rs](../../src-tauri/src/commands/menu.rs) 的 5 个菜单 + 最近打开子菜单需全部重写为 Vue 组件 + Tauri event 通信，工作量大。

**双轨：保留 OS 原生菜单 + 增加应用内品牌头部** —— 保留 Tauri 原生菜单（功能入口），在应用内增加 32px 头部条仅显示品牌"Murasaki"（无菜单项）。被否决：折中方案无显著价值，32px 头部条仅展示品牌性价比低。

## 后果

**正面**
- 保留 OS 原生菜单的集成优势（键盘、系统、可访问性）。
- 应用内布局无需大改，grid 简化为 `36px 1fr 24px`。
- [menu.rs](../../src-tauri/src/commands/menu.rs) 不动，无回归风险。

**负面**
- 与设计页视觉不一致。但这是"合理的架构偏离"——设计稿是视觉参考，不是实现蓝图。
- 跨平台一致性：Windows/macOS 的 OS 菜单栏视觉不同，但这是 OS 原生组件的预期行为，不是缺陷。

## 实施边界

- **设计页的 32px menubar 行不实现**：应用内 grid 从 `32px 36px 1fr 24px` 简化为 `36px 1fr 24px`。所有引用 `32px menubar` 的设计 CSS 在实现时跳过。
- **OS 原生菜单的结构保持**：[menu.rs](../../src-tauri/src/commands/menu.rs) 的 5 个菜单（文件/编辑/段落/主题/帮助）不动。未来若需调整菜单项（如 0.3.0 的"关于"对话框入口），仍在 [menu.rs](../../src-tauri/src/commands/menu.rs) 修改。
- **UX 对齐时菜单相关的对齐点**：不在菜单栏视觉，而在**右键菜单**（应用内组件，必须对齐设计规范）。
