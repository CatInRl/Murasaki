/**
 * 功能开关（Feature Flags）
 *
 * 集中管理实验性/未完成功能的显隐。当前 Agent 功能在 0.5.0 不可用（issue #112），
 * 通过此开关隐藏所有 Agent 相关入口与弹窗；恢复时仅需将 AGENT_ENABLED 置为 true。
 *
 * 覆盖范围（AGENT_ENABLED=false 时全部隐藏）：
 * - 右侧 Agent 面板（App.vue）与状态栏 Agent 指标（StatusBar.vue）
 * - 设置窗口的「AI」分类（SettingsApp.vue）
 * - 常规设置里的 Agent 分区（GeneralPanel.vue 的「显示 Agent 面板」开关）
 */
export const AGENT_ENABLED = false;