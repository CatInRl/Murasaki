/**
 * DocumentStore 的生产实现：把会话需要的磁盘能力接到现有 fileSystem 服务与 Tauri 命令上。
 *
 * 与 fileSystem.getMtime 的差别：这里不把失败吞成 0——mtime 是草稿冲突判定的基线，
 * 取不到应当报错，而不是伪造一个会让冲突判断失效的值。
 */
import { invoke } from "@tauri-apps/api/core";
import { fileSystem } from "../../services/fileSystem";
import type { DocumentStore, DraftSnapshot } from "./types";

export function createDocumentStore(): DocumentStore {
  return {
    readText(path: string): Promise<string> {
      return fileSystem.readText(path);
    },

    writeText(path: string, content: string): Promise<void> {
      return fileSystem.writeText(path, content);
    },

    mtime(path: string): Promise<number> {
      return invoke<number>("get_file_mtime", { path });
    },

    draftExists(path: string): Promise<boolean> {
      return fileSystem.draftExists(path);
    },

    async readDraft(path: string): Promise<DraftSnapshot> {
      const [content, meta] = await fileSystem.readDraft(path);
      return {
        content,
        knownMtime: meta.knownMtime,
        savedAt: meta.savedAt,
      };
    },

    writeDraft(path: string, content: string, knownMtime: number): Promise<void> {
      return fileSystem.saveDraft(path, content, knownMtime);
    },

    deleteDraft(path: string): Promise<void> {
      return fileSystem.deleteDraft(path);
    },
  };
}
