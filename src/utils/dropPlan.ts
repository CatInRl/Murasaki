/**
 * 拖放路径分类与打开动作规划（issue #92）
 *
 * Tauri 原生 drag-drop 事件（`onDragDropEvent`）只给一串路径字符串，目录/文件与存在性
 * 由 Rust `classify_drop_paths` 判定后回传。本模块把这份分类结果规划成打开动作，纯函数便于单测。
 *
 * 图片**不处理**（图片链路见 #288）：本 PR 只把图片单列进 `images` 供调用方忽略；
 * `useImagePaste.ts` 不做改动。
 *
 * 动作策略：
 * - **恰好一个目录、且没有可打开的文件** → 作为本窗口工作区打开；
 * - 其余情况 → 只把**可打开的文件**逐个打开为标签；图片 / 不支持的类型 / 缺失路径 /
 *   多投时被忽略的目录一律进 `skipped`。
 */
import { isEditableTextFile, isImageFile } from "./fileKind";

/** Rust `classify_drop_paths` 回传的单条分类结果 */
export type DropKind = "file" | "folder" | "missing";

export interface DropEntry {
  path: string;
  kind: DropKind;
}

export interface DropPlan {
  /** 单个目录 → 作为本窗口工作区打开；其余情况为 null */
  workspace: string | null;
  /** 可打开的文件 → 逐个打开为标签 */
  files: string[];
  /** 图片 → 本 PR 不处理（见 #288）；单列出来只为「不混进 files」 */
  images: string[];
  /** 一律跳过：不支持的类型、缺失路径、多投时被忽略的目录 */
  skipped: string[];
}

/**
 * 把拖放分类结果规划成打开动作。
 *
 * `workspace` 仅在「恰好一个目录且没有可打开文件」时给出：多个目录或目录与文件混投时，
 * 只打开文件，目录被忽略（避免一次拖放静默切换工作区或吞掉文件）。
 */
export function planDrop(entries: DropEntry[]): DropPlan {
  const folders: string[] = [];
  const files: string[] = [];
  const images: string[] = [];
  const skipped: string[] = [];

  for (const entry of entries) {
    if (entry.kind === "folder") {
      folders.push(entry.path);
      continue;
    }
    if (entry.kind === "missing") {
      skipped.push(entry.path);
      continue;
    }
    if (isImageFile(entry.path)) {
      images.push(entry.path);
      continue;
    }
    // 只开「应用能打开的文件」（口径见 fileKind.isEditableTextFile）。
    // 无后缀文件要拿到大小才能判定是否按文本处理，拖放这里给不出 → 按不支持忽略。
    if (isEditableTextFile(entry.path)) {
      files.push(entry.path);
    } else {
      skipped.push(entry.path);
    }
  }

  const workspace = folders.length === 1 && files.length === 0 ? folders[0] : null;
  if (workspace === null) skipped.push(...folders);

  return { workspace, files, images, skipped };
}
