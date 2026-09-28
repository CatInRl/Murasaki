/**
 * 拖放路径分类与打开动作规划（issue #92）
 *
 * Tauri 原生 drag-drop 事件（`onDragDropEvent`）只给一串路径字符串，目录/文件与存在性
 * 由 Rust `classify_drop_paths` 判定后回传。本模块把这份分类结果规划成动作，纯函数便于单测。
 *
 * 图片单独走一条链路（issue #288）：`planDrop` 把图片从 `files` 中排除并**单列到 `images`**，
 * 由 `useDragDrop` 交给 `useImagePaste` 按插入方式落图/内嵌后插入编辑器（不打开标签、
 * 也不因此切换工作区）。
 *
 * 动作策略（见 `planDrop` 的 JSDoc）：不支持的类型 / 缺失路径 / 多投时被忽略的目录
 * 一律**不进 `files`、也不设 `workspace`**。
 */
import { isEditableTextFile, isImageFile } from "./fileKind";

/** Rust `classify_drop_paths` 回传的单条分类结果 */
export type DropKind = "file" | "folder" | "missing";

export interface DropEntry {
  path: string;
  kind: DropKind;
}

export interface DropPlan {
  /** 单个目录 → 作为工作区打开（走「打开文件夹」路径：同目录聚焦 / 否则新窗口）；其余情况为 null */
  workspace: string | null;
  /** 可打开的文件 → 在当前窗口逐个打开为标签 */
  files: string[];
  /** 外部图片 → 在当前窗口按插入方式插入编辑器（保持拖入顺序） */
  images: string[];
}

/**
 * 把拖放分类结果规划成打开动作。
 *
 * `workspace` 仅在「恰好一个目录且没有可打开文件」时给出：多个目录或目录与文件混投时，
 * 只打开文件，目录被忽略（避免一次拖放静默切换工作区或吞掉文件）。
 *
 * 图片记为 `images`（不进 `files`、也不设 `workspace`）；不支持的类型 / 缺失路径 /
 * 多投时被忽略的目录：不产生任何动作。
 */
export function planDrop(entries: DropEntry[]): DropPlan {
  const folders: string[] = [];
  const files: string[] = [];
  const images: string[] = [];

  for (const entry of entries) {
    if (entry.kind === "folder") {
      folders.push(entry.path);
      continue;
    }
    if (entry.kind === "missing") continue;
    if (isImageFile(entry.path)) {
      images.push(entry.path);
      continue;
    }
    // 只开「应用能打开的文件」（口径见 fileKind.isEditableTextFile）。
    // 无后缀文件自 #308 起不再按大小拦截（拖放拿不到大小，此前一律被忽略），
    // 一并交给打开路径按文本试探读。
    if (isEditableTextFile(entry.path)) files.push(entry.path);
  }

  const workspace = folders.length === 1 && files.length === 0 ? folders[0] : null;

  return { workspace, files, images };
}
