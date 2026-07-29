# ADR 0009: 设置窗口改为 Tauri 多窗口形态

## 状态

已接受

## 背景

参考设计（`murasaki-ui-design/pages/settings-general.html` 等）用的是全屏窗口布局（`100vw/100vh`，44px 标题栏 + 200px 侧栏 + 内容区，标题栏带 `-webkit-app-region: drag`）。

当前实现是 720px 的 `NModal preset="card"` 弹窗（[SettingsWindow.vue](../../src/components/SettingsWindow.vue)），与设计系统的"全屏窗口"语义不一致。

且 0.3.0 设置项会扩充（编辑模式三选一、字体大小/行高/字体族、AI 高级参数等），720px 模态会拥挤。

## 决策

设置窗口改为 **Tauri 多窗口（独立 WebviewWindow）** 形态，作为独立 OS 窗口存在。

## 理由

1. **参考设计的标题栏 `-webkit-app-region: drag` 强烈暗示 OS 级窗口** —— NModal 模拟不出真窗口的拖动/最小化行为。
2. **设置项扩充需要更大空间** —— 0.3.0 新增编辑模式三选一、字体大小/行高/字体族、AI 高级参数等，720px 模态会拥挤；独立窗口给足空间。
3. **多窗口是 Tauri 的原生能力** —— 配置 `tauri.conf.json` 的 windows 数组 + 一个新的入口 HTML。技术成本中等，但最符合参考设计的"全屏窗口"语义。
4. **用户可同时看主编辑器和设置** —— 双窗口并排，主窗口不被遮挡。
5. **与 CONTEXT.md 现有定义"独立的模态设置窗口"一致** —— 把它从"模态"升级为"独立窗口"是术语锐化，不是破坏。
6. **后续可复用此模式** —— 「关于」「对比窗口」等也可复用多窗口模式。

## 备选方案

**接近全屏的 NModal 覆盖层** —— 保留 NModal 但改为 `95vw × 92vh`，内部用参考设计的 grid 布局。被否决：技术成本最低，但仍是模态遮罩，主窗口被遮挡，且 `-webkit-app-region: drag` 在 WebView 内的 NModal 上意义不大（无 OS 窗口拖动）。

**内嵌面板（非弹窗）** —— 设置作为主窗口右侧抽屉或全屏替换。被否决：不符合参考设计的"独立窗口"语义。

## 后果

**正面**
- 设置作为独立 OS 窗口，可独立最小化/关闭，主窗口不被遮挡。
- 给足空间容纳扩充的设置项。
- 与参考设计的"全屏窗口"语义一致。

**负面**
- 独立窗口意味着设置变更需要跨窗口通信（Tauri event）通知主窗口应用副作用（如主题切换），比当前同窗口 emit 复杂一些。但这正是显式 save 模型的好处（见保存模型决策）。
- 需配置 `tauri.conf.json` 的 windows 数组 + 新的入口 HTML。

## 实施边界

### 窗口配置

- 在 `tauri.conf.json` 的 windows 数组新增 settings 窗口配置（label: `settings`，初始隐藏）。
- 新增 `settings.html` 入口（与 `index.html` 并列）。
- 通过 Tauri 命令创建/显示设置窗口。

### 跨窗口通信

- 设置变更通过 Tauri event 通知主窗口应用副作用（如 UI 模式切换、编辑模式切换）。
- 主窗口监听 `settings://saved` 事件，应用变更。

### 设置分类（0.3.0）

3 个分类（无主题/快捷键）：
- **常规**：UI 模式 / 显示隐藏文件 / 显示 Agent 面板 / 默认图片目录
- **编辑器**：编辑模式（source/split/wysiwyg）/ 字体大小 / 行高 / 字体族 / 显示行号 / 软折行
- **AI**：Provider 列表 + 编辑表单 / 默认 Provider / 高级参数折叠区（4 项统一设置）

### 保存模型：显式 Save

- footer 含「恢复默认 / 保存」两个按钮（对齐参考设计）
- 改动暂存 draft，点保存才落盘 + 触发副作用
- 点恢复默认重置当前分类
- 关闭未保存弹确认（与 tab 关闭未保存逻辑一致）
- 副作用统一触发（一次 save 把所有改动一次性应用）

### AI 分类补充决策

- **Provider 类型**：仅支持「OpenAI 兼容」，**不支持 Azure OpenAI**（UX 设计页需移除该选项，0.3.0 不实现，未来版本再考虑）
- **测试连接**：0.3.0 实现。`useAiProvidersStore` 新增 `testProvider(id)` 方法，向后端 `GET /v1/models` 发请求验证连通性，返回成功/失败 + 错误信息。状态指示器显示上次测试结果（存 localStorage）
- **Provider 删除二次确认**：点击删除按钮弹 confirm 对话框（"确定删除 Provider {name}？"），确认后删除。Provider 配置含 apiKey（输入成本高），误删损失大，撤销吐司的 5s 窗口太短
