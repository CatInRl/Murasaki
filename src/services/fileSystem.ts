/**
 * 文件系统适配器（fileSystem）
 *
 * 统一封装所有 Tauri 文件命令，供 useTabsStore / useFileOpsStore / useFileActions / useHtmlExport 共用。
 * 消除之前散落在各 store / composable 的 invoke 调用碎片化。
 *
 * 设计原则：
 * - 纯服务模块，不依赖任何 Pinia store
 * - 所有方法返回 Promise，错误向上传播（由调用方决定如何处理）
 */
import { invoke } from "@tauri-apps/api/core";
import type { TreeNode } from "../types";

/**
 * 草稿元数据（与 Rust 端 DraftMeta 对齐）
 */
export interface DraftMeta {
  knownMtime: number;
  savedAt: number;
}

/**
 * Agent 写文件结果
 */
export interface AgentWriteResult {
  docPath: string;
  absolutePath: string;
  contentLength: number;
}

/**
 * 文件系统适配器
 *
 * 集中管理所有 Tauri 文件命令调用，消除 invoke 散落。
 * 测试时可 mock 此模块而非 mock Tauri invoke。
 */
export const fileSystem = {
  // ===== 基础 IO =====

  /** 读取文本文件 */
  async readText(path: string): Promise<string> {
    return invoke<string>("read_text_file", { path });
  },

  /** 写入文本文件 */
  async writeText(path: string, content: string): Promise<void> {
    await invoke("write_text_file", { path, content });
  },

  /** 读取二进制文件（返回 number[] 兼容 Tauri 序列化） */
  async readBinary(path: string): Promise<number[]> {
    return invoke<number[]>("read_binary_file", { path });
  },

  /** 获取文件 mtime（毫秒），失败返回 0 */
  async getMtime(path: string): Promise<number> {
    return invoke<number>("get_file_mtime", { path }).catch(() => 0);
  },

  /** 检查路径是否存在，失败返回 false */
  async exists(path: string): Promise<boolean> {
    return invoke<boolean>("path_exists", { path }).catch(() => false);
  },

  /** 获取路径类型（"file" | "directory" | "none"），失败返回 "none" */
  async pathType(path: string): Promise<string> {
    return invoke<string>("path_type", { path }).catch(() => "none");
  },

  // ===== 文件树操作 =====

  /** 新建文件，返回树节点 */
  async createFile(path: string): Promise<TreeNode> {
    return invoke<TreeNode>("create_file", { path });
  },

  /** 新建文件夹，返回树节点 */
  async createDirectory(path: string): Promise<TreeNode> {
    return invoke<TreeNode>("create_directory", { path });
  },

  /** 删除文件/文件夹（走系统回收站） */
  async deletePath(path: string): Promise<void> {
    await invoke("delete_path", { path });
  },

  /** 重命名/移动文件或文件夹 */
  async renamePath(from: string, to: string): Promise<TreeNode> {
    return invoke<TreeNode>("rename_path", { from, to });
  },

  /** 复制文件 */
  async copyFile(from: string, to: string): Promise<void> {
    await invoke("copy_file", { from, to });
  },

  /** 在系统资源管理器中显示 */
  async revealInExplorer(path: string): Promise<void> {
    await invoke("reveal_in_explorer", { path });
  },

  // ===== 草稿专用 =====

  /** 检查草稿是否存在 */
  async draftExists(path: string): Promise<boolean> {
    return invoke<boolean>("draft_exists", { path }).catch(() => false);
  },

  /** 读取草稿内容及元数据 */
  async readDraft(path: string): Promise<[string, DraftMeta]> {
    return invoke<[string, DraftMeta]>("read_draft", { path });
  },

  /** 保存草稿 */
  async saveDraft(path: string, content: string, knownMtime: number): Promise<void> {
    await invoke("save_draft", { path, content, knownMtime });
  },

  /** 删除草稿（静默失败） */
  async deleteDraft(path: string): Promise<void> {
    await invoke("delete_draft", { path }).catch(() => {});
  },

  // ===== Agent 写文件 =====

  /**
   * Agent 写文件（通过 Rust 端 agent_write_file 命令）
   *
   * 候选 2 阶段 1：从 useProposalsStore 迁移至此，消除动态 import。
   */
  async writeAgentFile(
    workspace: string,
    path: string,
    content: string
  ): Promise<AgentWriteResult> {
    return invoke<AgentWriteResult>("agent_write_file", { workspace, path, content });
  },

  /** 解析工作区内相对路径为绝对路径（agent 覆盖文件时用） */
  async resolveAgentPath(workspace: string, path: string): Promise<string | null> {
    return invoke<string>("agent_resolve_workspace_path", { workspace, path }).catch(
      () => null
    );
  },

  // ===== PDF 导出 =====

  /**
   * 调用 Rust 端 export_pdf 命令，通过 WebView2 PrintToPdf 静默导出 PDF。
   * 接收完整 HTML 字串（来自 exportHtml）+ 输出路径，返回 void。
   */
  async exportPdf(html: string, outputPath: string): Promise<void> {
    await invoke("export_pdf", { html, outputPath });
  },
};
