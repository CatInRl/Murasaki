/**
 * 文件选择对话框（#437）。
 *
 * 走 Rust 侧命令而不是 `@tauri-apps/plugin-dialog`：选中路径需要当场写入
 * 路径白名单（用户手势 = 授权），这一步必须在可信进程里完成。
 */
import { invoke } from "@tauri-apps/api/core";

export interface FileDialogFilter {
  name: string;
  extensions: string[];
}

export interface FileDialogOptions {
  title?: string;
  /** 起始目录；带文件名时作为默认文件名 */
  defaultPath?: string;
  filters?: FileDialogFilter[];
}

export function pickFile(options: FileDialogOptions = {}): Promise<string | null> {
  return invoke<string | null>("pick_file", { options });
}

export function pickSave(options: FileDialogOptions = {}): Promise<string | null> {
  return invoke<string | null>("pick_save", { options });
}

export function pickFolder(options: FileDialogOptions = {}): Promise<string | null> {
  return invoke<string | null>("pick_folder", { options });
}
