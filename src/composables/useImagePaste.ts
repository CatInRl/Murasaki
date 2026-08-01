import type { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { relativePath as computeRelativePath, extname } from "../utils/path";

/**
 * 图片粘贴/拖入 composable
 *
 * 处理两种场景（spec：图片处理流程）：
 * 1. 粘贴剪贴板图片 → 保存到 <workspace>/assets/ → 插入 ![](assets/<filename>)
 * 2. 拖入外部图片文件 → 复制到 <workspace>/assets/ → 插入 ![](assets/<filename>)
 * 3. 从文件树拖入已存在图片 → 计算相对当前 md 文件的相对路径 → 插入 ![](<relative-path>)
 *
 * 文件名规则：YYYYMMDD-HHmmss-<6hex>.<ext>
 */

export interface UseImagePasteOptions {
  /** 获取当前编辑器 view */
  getEditorView: () => EditorView | null;
  /** 获取当前工作区路径 */
  getWorkspacePath: () => string | null;
  /** 获取当前打开的 md 文件路径（用于计算相对路径） */
  getCurrentFilePath: () => string | null;
}

export interface UseImagePaste {
  /** 注册 paste / drop 监听器（在 onMounted 中调用） */
  setup(): void;
  /** 移除监听器（在 onBeforeUnmount 中调用） */
  teardown(): void;
  /**
   * 处理粘贴事件：检测剪贴板是否含图片，若有则保存到 assets 并插入 markdown
   * 返回 true 表示已处理（应阻止默认粘贴行为）
   */
  handlePaste(e: ClipboardEvent): Promise<boolean>;
  /**
   * 处理拖放事件：检测是否为图片文件，若是则复制到 assets 并插入 markdown
   * 返回 true 表示已处理
   */
  handleDrop(e: DragEvent): Promise<boolean>;
  /**
   * 从文件树拖入已有图片：使用相对当前 md 文件的路径写法（不复制）
   */
  insertExistingImage(absolutePath: string): boolean;
}

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];

export function isImageExt(ext: string): boolean {
  return IMAGE_EXTENSIONS.includes(ext.toLowerCase());
}

/** 计算从 fromFile 到 toPath 的相对路径（如 ../assets/foo.png） */
export function relativePath(fromFile: string, toPath: string): string {
  return computeRelativePath(fromFile, toPath);
}

export function useImagePaste(options: UseImagePasteOptions): UseImagePaste {
  const { getEditorView, getWorkspacePath, getCurrentFilePath } = options;

  /**
   * 在编辑器当前光标处插入 markdown 图片引用
   */
  function insertMarkdownImage(view: EditorView, path: string): void {
    const markdown = `![](${path})`;
    const { head } = view.state.selection.main;
    view.dispatch({
      changes: { from: head, to: head, insert: markdown },
      selection: { anchor: head + 2, head: head + 2 }, // 光标放在 [] 内
    });
    view.focus();
  }

  /**
   * 从剪贴板事件中提取图片 blob 并转为字节数组
   */
  async function extractImageBytes(e: ClipboardEvent): Promise<{ bytes: Uint8Array; ext: string } | null> {
    const items = e.clipboardData?.items;
    if (!items) return null;
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (!file) continue;
        const ext = extname(file.name) || (file.type.split("/").pop() ?? "png");
        const arrayBuffer = await file.arrayBuffer();
        return { bytes: new Uint8Array(arrayBuffer), ext };
      }
    }
    return null;
  }

  async function handlePaste(e: ClipboardEvent): Promise<boolean> {
    const workspace = getWorkspacePath();
    if (!workspace) return false;
    const view = getEditorView();
    if (!view) return false;

    const extracted = await extractImageBytes(e);
    if (!extracted) return false;

    try {
      // 将 Uint8Array 转为 number[] 以匹配 Rust 的 Vec<u8>
      const bytes = Array.from(extracted.bytes);
      const result = await invoke<{
        absolutePath: string;
        relativePath: string;
        filename: string;
      }>("save_image_asset", {
        workspace,
        bytes,
        ext: extracted.ext,
      });
      insertMarkdownImage(view, result.relativePath);
      return true;
    } catch (err) {
      console.error("保存粘贴图片失败:", err);
      return false;
    }
  }

  async function handleDrop(e: DragEvent): Promise<boolean> {
    const workspace = getWorkspacePath();
    if (!workspace) return false;
    const view = getEditorView();
    if (!view) return false;

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return false;

    // 仅处理第一个图片文件
    const file = files[0];
    const ext = extname(file.name);
    if (!isImageExt(ext)) return false;

    // 读取文件内容
    const arrayBuffer = await file.arrayBuffer();
    const bytes = Array.from(new Uint8Array(arrayBuffer));

    try {
      const result = await invoke<{
        absolutePath: string;
        relativePath: string;
        filename: string;
      }>("save_image_asset", {
        workspace,
        bytes,
        ext,
      });
      insertMarkdownImage(view, result.relativePath);
      e.preventDefault();
      return true;
    } catch (err) {
      console.error("保存拖入图片失败:", err);
      return false;
    }
  }

  /**
   * 从文件树拖入已有图片：使用相对当前 md 文件的路径写法（不复制）
   */
  function insertExistingImage(absolutePath: string): boolean {
    const view = getEditorView();
    if (!view) return false;
    const currentFile = getCurrentFilePath();
    if (!currentFile) {
      // 没有当前文件：直接用绝对路径
      insertMarkdownImage(view, absolutePath);
      return true;
    }
    const rel = relativePath(currentFile, absolutePath);
    insertMarkdownImage(view, rel);
    return true;
  }

  // 监听器引用，便于卸载
  let pasteHandler: ((e: ClipboardEvent) => void) | null = null;
  let dropHandler: ((e: DragEvent) => void) | null = null;

  function setup(): void {
    pasteHandler = (e: ClipboardEvent) => {
      void handlePaste(e).then((handled) => {
        if (handled) {
          e.preventDefault();
        }
      });
    };
    dropHandler = (e: DragEvent) => {
      void handleDrop(e);
    };
    // 监听 window 级 paste 事件（编辑器宿主元素）
    window.addEventListener("paste", pasteHandler);
    window.addEventListener("drop", dropHandler);
  }

  function teardown(): void {
    if (pasteHandler) {
      window.removeEventListener("paste", pasteHandler);
      pasteHandler = null;
    }
    if (dropHandler) {
      window.removeEventListener("drop", dropHandler);
      dropHandler = null;
    }
  }

  return {
    setup,
    teardown,
    handlePaste,
    handleDrop,
    insertExistingImage,
  };
}
