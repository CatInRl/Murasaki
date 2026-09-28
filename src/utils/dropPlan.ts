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
 * 一律**不进 `files`、也不设 `workspace`**；其中「不支持类型的文件」另收进
 * `unsupportedFiles`、「被忽略的目录」另收进 `ignoredFolders`，由调用方给出可见反馈
 * （issue #317 / #318）—— 拖入路径此前是四个入口里唯一「什么都不发生」的
 * （文件树点击 / 右键 / 打开失败都已有兜底出口，见 #307/#308）。
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
  /**
   * 应用打不开的文件（不支持的类型，见 `fileKind.isEditableTextFile`）—— 不产生打开动作，
   * 但**要**让调用方给出提示（issue #317）。不含缺失路径，也不含多投时被忽略的目录。
   */
  unsupportedFiles: string[];
  /**
   * 被忽略的目录 —— 多个目录、或目录与文件混投时，目录不进 `workspace` 也不打开，
   * 但**要**让调用方给出提示（issue #318）。不含缺失路径。
   *
   * 单个目录**被用作工作区**时不在其中（那是正常动作，不是被忽略）。
   */
  ignoredFolders: string[];
}

/**
 * 把拖放分类结果规划成打开动作。
 *
 * `workspace` 仅在「恰好一个目录且没有可打开文件」时给出：多个目录或目录与文件混投时，
 * 只打开文件，目录被忽略（避免一次拖放静默切换工作区或吞掉文件）—— 一个窗口只能有一个
 * 工作区（见 ADR-0018），所以这些目录只能被忽略，但会被记进 `ignoredFolders` 让调用方
 * 提示一句（#318）。若要让多目录各开一个窗口，那是另一件事：会改掉上面这个取舍，需单议。
 *
 * 图片记为 `images`（不进 `files`、也不设 `workspace`）；不支持的类型 / 缺失路径 /
 * 多投时被忽略的目录：不产生任何打开动作。其中**不支持类型的文件**记进
 * `unsupportedFiles`（#317）、**被忽略的目录**记进 `ignoredFolders`（#318）供调用方提示；
 * 缺失路径保持静默 —— 那是「不该发生」（路径由 OS 给出，拖入到落下之间被删掉）。
 */
export function planDrop(entries: DropEntry[]): DropPlan {
  const folders: string[] = [];
  const files: string[] = [];
  const images: string[] = [];
  const unsupportedFiles: string[] = [];

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
    else unsupportedFiles.push(entry.path);
  }

  const workspace = folders.length === 1 && files.length === 0 ? folders[0] : null;
  // 没被用作工作区的目录都是「被忽略」的（多目录，或目录与文件混投）
  const ignoredFolders = workspace ? [] : folders;

  return { workspace, files, images, unsupportedFiles, ignoredFolders };
}
