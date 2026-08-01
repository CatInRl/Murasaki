import { defineStore } from "pinia";
import { useWorkspaceStore } from "./useWorkspaceStore";
import { fileSystem } from "../services/fileSystem";
import type { TreeNode } from "../types";

/**
 * 文件操作 Store
 *
 * 集中管理文件树上的右键菜单操作：
 * - 新建文件 / 新建文件夹
 * - 重命名（处理冲突 → 覆盖 / 重命名 / 取消）
 * - 删除（移至系统回收站）
 * - 剪切 / 复制 / 粘贴
 * - 在资源管理器中显示
 *
 * 所有冲突统一通过 askConflict 回调处理，由 App.vue 注入对话框实现。
 */

export interface ConflictResolver {
  (
    targetPath: string,
    operation: "rename" | "copy" | "save-as",
    sourcePath?: string
  ): Promise<{ action: "overwrite" | "rename" | "cancel"; newName?: string }>;
}

export const useFileOpsStore = defineStore("fileOps", () => {
  const workspace = useWorkspaceStore();

  /** 剪贴板：存放已剪切/复制的路径 */
  let clipboard: { path: string; mode: "cut" | "copy" } | null = null;

  /** 冲突解决回调（由 App.vue 注入） */
  let conflictResolver: ConflictResolver | null = null;

  /** 注入冲突解决回调 */
  function setConflictResolver(resolver: ConflictResolver | null): void {
    conflictResolver = resolver;
  }

  /**
   * 检查目标路径是否存在并解决冲突（消除 4 处重复的 exists+pathType+conflictResolver 模式）
   *
   * - 目标不存在：返回 null（无冲突，调用方直接执行操作）
   * - 目标存在且是目录：抛出错误（spec 禁止覆盖目录）
   * - 目标存在且是文件：调用 conflictResolver 让用户选择
   *
   * @returns 冲突解决结果，或 null 表示无冲突
   */
  async function checkAndResolveConflict(
    targetPath: string,
    operation: "rename" | "copy",
    sourcePath: string
  ): Promise<{ action: "overwrite" | "rename" | "cancel"; newName?: string } | null> {
    const exists = await fileSystem.exists(targetPath);
    if (!exists) return null;

    const targetType = await fileSystem.pathType(targetPath);
    if (targetType === "directory") {
      throw new Error("无法覆盖目录，请使用不同的名称");
    }

    if (!conflictResolver) {
      throw new Error("未配置冲突对话框");
    }

    return conflictResolver(targetPath, operation, sourcePath);
  }

  /** 规范化路径分隔符为 / */
  function normalize(path: string): string {
    return path.replace(/\\/g, "/");
  }

  /** 从路径中提取父目录（保留绝对路径的前导 /） */
  function parentDir(path: string): string {
    const normalized = normalize(path);
    const isAbsolute = normalized.startsWith("/");
    const parts = normalized.split("/").filter(Boolean);
    parts.pop();
    if (parts.length === 0) {
      return isAbsolute ? "/" : ".";
    }
    const joined = parts.join("/");
    return isAbsolute ? "/" + joined : joined;
  }

  /** 从路径中提取文件名 */
  function basename(path: string): string {
    const parts = normalize(path).split("/").filter(Boolean);
    return parts[parts.length - 1] ?? path;
  }

  /** 拼接路径（统一使用 / 分隔符，Rust PathBuf 在 Windows 上可正确解析） */
  function joinPath(dir: string, name: string): string {
    const d = dir.replace(/[\\/]+$/, "");
    const n = name.replace(/^[\\/]+/, "");
    return d + "/" + n;
  }

  /**
   * 新建文件
   * @param dirPath 父目录
   * @param name 文件名
   */
  async function createFile(dirPath: string, name: string): Promise<TreeNode | null> {
    const fullPath = joinPath(dirPath, name);
    try {
      const node = await fileSystem.createFile(fullPath);
      await workspace.refreshTree();
      return node;
    } catch (err) {
      console.error("新建文件失败:", err);
      throw err;
    }
  }

  /**
   * 新建文件夹
   */
  async function createDirectory(dirPath: string, name: string): Promise<TreeNode | null> {
    const fullPath = joinPath(dirPath, name);
    try {
      const node = await fileSystem.createDirectory(fullPath);
      await workspace.refreshTree();
      return node;
    } catch (err) {
      console.error("新建文件夹失败:", err);
      throw err;
    }
  }

  /**
   * 删除文件/文件夹（走系统回收站）
   */
  async function deletePath(path: string): Promise<void> {
    try {
      await fileSystem.deletePath(path);
      await workspace.refreshTree();
    } catch (err) {
      console.error("删除失败:", err);
      throw err;
    }
  }

  /**
   * 重命名/移动：处理目标已存在冲突
   * - 若目标不存在：直接重命名
   * - 若目标存在：弹出冲突对话框（覆盖/重命名/取消）
   *   - 覆盖：先删除目标，再重命名
   *   - 重命名：用新名字重试
   *   - 取消：返回 null
   */
  async function renamePath(
    oldPath: string,
    newName: string
  ): Promise<TreeNode | null> {
    const dir = parentDir(oldPath);
    const newPath = joinPath(dir, newName);

    // 同名：无需操作
    if (normalize(oldPath) === normalize(newPath)) {
      return null;
    }

    const conflict = await checkAndResolveConflict(newPath, "rename", oldPath);
    if (conflict) {
      if (conflict.action === "cancel") return null;
      if (conflict.action === "rename") {
        if (!conflict.newName) return null;
        return renamePath(oldPath, conflict.newName);
      }
      // overwrite：先删除目标
      await fileSystem.deletePath(newPath);
    }

    try {
      const node = await fileSystem.renamePath(oldPath, newPath);
      await workspace.refreshTree();
      return node;
    } catch (err) {
      console.error("重命名失败:", err);
      throw err;
    }
  }

  /**
   * 剪切：记录路径与模式
   */
  function cut(path: string): void {
    clipboard = { path, mode: "cut" };
  }

  /**
   * 复制：记录路径与模式
   */
  function copy(path: string): void {
    clipboard = { path, mode: "copy" };
  }

  /**
   * 粘贴到目标目录
   * - cut 模式：调用 rename_path 移动
   * - copy 模式：调用 copy_file 复制（仅文件）
   * 处理目标已存在冲突
   */
  async function paste(targetDir: string): Promise<void> {
    if (!clipboard) return;
    const { path: src, mode } = clipboard;
    const name = basename(src);
    const targetPath = joinPath(targetDir, name);

    if (normalize(src) === normalize(targetPath)) {
      // 同路径无需操作
      clipboard = null;
      return;
    }

    const conflict = await checkAndResolveConflict(
      targetPath,
      mode === "cut" ? "rename" : "copy",
      src
    );
    if (conflict) {
      if (conflict.action === "cancel") return;
      if (conflict.action === "rename") {
        if (!conflict.newName) return;
        const newTarget = joinPath(targetDir, conflict.newName);
        if (mode === "cut") {
          await fileSystem.renamePath(src, newTarget);
        } else {
          await fileSystem.copyFile(src, newTarget);
        }
        await workspace.refreshTree();
        if (mode === "cut") clipboard = null;
        return;
      }
      // overwrite：先删除目标
      await fileSystem.deletePath(targetPath);
    }

    try {
      if (mode === "cut") {
        await fileSystem.renamePath(src, targetPath);
        clipboard = null;
      } else {
        await fileSystem.copyFile(src, targetPath);
      }
      await workspace.refreshTree();
    } catch (err) {
      console.error("粘贴失败:", err);
      throw err;
    }
  }

  /**
   * 在系统资源管理器中显示
   */
  async function revealInExplorer(path: string): Promise<void> {
    try {
      await fileSystem.revealInExplorer(path);
    } catch (err) {
      console.error("在资源管理器中显示失败:", err);
      throw err;
    }
  }

  /**
   * 复制绝对路径到系统剪贴板
   */
  async function copyAbsolutePath(path: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(path);
    } catch (err) {
      console.error("复制绝对路径失败:", err);
      throw err;
    }
  }

  /**
   * 复制相对工作区根的路径到系统剪贴板
   * 若无工作区则回退为绝对路径
   */
  async function copyRelativePath(path: string): Promise<void> {
    try {
      const root = workspace.workspacePath;
      if (!root) {
        await navigator.clipboard.writeText(path);
        return;
      }
      const rel = relativePath(root, path);
      await navigator.clipboard.writeText(rel);
    } catch (err) {
      console.error("复制相对路径失败:", err);
      throw err;
    }
  }

  /**
   * 计算从 from 到 to 的相对路径（不依赖 path 模块，纯字符串处理）
   * 输入路径会被规范化为 / 分隔符
   */
  function relativePath(from: string, to: string): string {
    const normFrom = normalize(from).replace(/[\\/]+$/, "").split("/").filter(Boolean);
    const normTo = normalize(to).split("/").filter(Boolean);
    let i = 0;
    while (i < normFrom.length && i < normTo.length && normFrom[i] === normTo[i]) {
      i++;
    }
    const upCount = normFrom.length - i;
    const downParts = normTo.slice(i);
    const parts: string[] = [];
    for (let k = 0; k < upCount; k++) parts.push("..");
    for (const p of downParts) parts.push(p);
    return parts.length === 0 ? "." : parts.join("/");
  }

  /**
   * 工作区内移动（拖拽=移动语义）
   * @param src 源路径
   * @param targetDir 目标目录
   */
  async function moveInto(src: string, targetDir: string): Promise<void> {
    const name = basename(src);
    const targetPath = joinPath(targetDir, name);

    if (normalize(src) === normalize(targetPath)) return;

    // 禁止目录覆盖
    const srcType = await fileSystem.pathType(src);
    if (srcType === "directory") {
      // 检查目标是否是源目录的子目录（会导致递归移动）
      const targetIsInsideSource = normalize(targetPath).startsWith(normalize(src) + "/");
      if (targetIsInsideSource) {
        throw new Error("无法将目录移动到其自身子目录内");
      }
    }

    const conflict = await checkAndResolveConflict(targetPath, "rename", src);
    if (conflict) {
      if (conflict.action === "cancel") return;
      if (conflict.action === "rename") {
        if (!conflict.newName) return;
        const newTarget = joinPath(targetDir, conflict.newName);
        await fileSystem.renamePath(src, newTarget);
        await workspace.refreshTree();
        return;
      }
      // overwrite
      await fileSystem.deletePath(targetPath);
    }

    try {
      await fileSystem.renamePath(src, targetPath);
      await workspace.refreshTree();
    } catch (err) {
      console.error("工作区内移动失败:", err);
      throw err;
    }
  }

  /**
   * 外部文件拖入=复制（保留原文件）
   * @param src 外部源路径
   * @param targetDir 目标目录（工作区内）
   */
  async function copyInto(src: string, targetDir: string): Promise<void> {
    const name = basename(src);
    const targetPath = joinPath(targetDir, name);

    const conflict = await checkAndResolveConflict(targetPath, "copy", src);
    if (conflict) {
      if (conflict.action === "cancel") return;
      if (conflict.action === "rename") {
        if (!conflict.newName) return;
        const newTarget = joinPath(targetDir, conflict.newName);
        await fileSystem.copyFile(src, newTarget);
        await workspace.refreshTree();
        return;
      }
      await fileSystem.deletePath(targetPath);
    }

    try {
      await fileSystem.copyFile(src, targetPath);
      await workspace.refreshTree();
    } catch (err) {
      console.error("外部拖入复制失败:", err);
      throw err;
    }
  }

  /** 是否有可粘贴的内容 */
  function hasClipboard(): boolean {
    return clipboard !== null;
  }

  return {
    setConflictResolver,
    createFile,
    createDirectory,
    deletePath,
    renamePath,
    cut,
    copy,
    paste,
    revealInExplorer,
    copyAbsolutePath,
    copyRelativePath,
    moveInto,
    copyInto,
    hasClipboard,
  };
});
