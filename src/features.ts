/**
 * 功能开关（Feature Flags）
 *
 * 集中管理实验性/未完成功能的显隐。当前 Agent 功能在 0.5.0 不可用（issue #112），
 * 通过此开关隐藏所有 Agent 相关入口与弹窗；恢复时仅需将 AGENT_ENABLED 置为 true。
 */
export const AGENT_ENABLED = false;