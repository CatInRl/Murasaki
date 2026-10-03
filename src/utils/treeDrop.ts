/**
 * 文件树拖入编辑器的分流判定（issue #379）
 *
 * 修复前 TreeNode 对所有文件统一携带拖拽 MIME，EditorPane 的 onEditorDrop
 * 不区分类型一律走图片插入 —— 拖 notes.md 进编辑器会插入 `![](notes.md)`。
 *
 * 分流口径与 ADR-0020 的打开矩阵一致：
 * - 图片 → 插入相对路径引用（不复制，现状保留）
 * - 应用打得开（markdown / 白名单文本 / 无后缀）→ 打开为 tab
 * - 应用打不开（pdf / zip / exe …）→ 系统默认程序兜底（#307 出口）
 * - 目录 → 忽略（目录拖入编辑器没有明确意图；也不能静默改当前窗口的工作区）
 */
import { isImageFile, canOpenInApp } from "./fileKind";

/** 文件树拖入编辑器时按类型分流的动作 */
export type TreeDropAction = "insert-image" | "open-tab" | "system-open" | "ignore";

/**
 * 判定文件树节点拖入编辑器后的动作。
 *
 * @param nodeType 文件树节点类型（拖拽开始时随 MIME 携带，未知按文件处理）
 * @param name 文件名或路径（内部按扩展名判定，与 fileKind 同口径）
 */
export function classifyTreeDrop(
  nodeType: "file" | "directory" | string,
  name: string
): TreeDropAction {
  if (nodeType === "directory") return "ignore";
  if (isImageFile(name)) return "insert-image";
  if (canOpenInApp(name)) return "open-tab";
  return "system-open";
}
