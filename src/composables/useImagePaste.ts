import type { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { relativePath as computeRelativePath, extname } from "../utils/path";
import { isImageFile } from "../utils/fileKind";
import type { ImageInsertMode } from "../types";

/**
 * 图片粘贴/拖入 composable
 *
 * 处理三种场景（spec：图片处理流程；issue #151 补「插入方式」策略）：
 * 1. 粘贴剪贴板图片 → 按插入方式处理
 * 2. 拖入外部图片文件 → 按插入方式处理，插入点在**落点**（取不到坐标时回退光标）
 * 3. 从文件树拖入已存在图片 → 计算相对当前 md 文件的相对路径（不复制，不受插入方式影响）
 *
 * 插入方式（设置项 `imageInsertMode`）：
 * - `file`（默认）：复制到 `defaultImageDir` → 插入相对路径，如 `![](assets/images/20260726-153045-a1b2c3.png)`
 * - `base64`：读取字节转 `data:` URI 内嵌，不落盘
 *
 * 两条额外规则：
 * - 按住 `Alt`：本次插入临时用**另一种**方式（不改设置）
 * - 无工作区 / 落盘失败：自动回退 `base64`（file 模式无法落盘时不能静默丢图）
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
  /** 配置的插入方式（设置项 imageInsertMode） */
  getInsertMode: () => ImageInsertMode;
  /** file 模式下落盘的相对目录（设置项 defaultImageDir） */
  getImageDir: () => string;
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

const IMAGE_EXT_FALLBACK = "png";

/** 计算从 fromFile 到 toPath 的相对路径（如 ../assets/foo.png） */
export function relativePath(fromFile: string, toPath: string): string {
  return computeRelativePath(fromFile, toPath);
}

/**
 * 解析本次插入实际使用的方式（纯函数，便于单测）
 *
 * - 无工作区：file 模式无法落盘 → 一律回退 `base64`
 * - 按住 Alt：临时取反配置（本次有效，不改设置）
 */
export function resolveInsertMode(opts: {
  configured: ImageInsertMode;
  altKey?: boolean;
  hasWorkspace: boolean;
}): ImageInsertMode {
  if (!opts.hasWorkspace) return "base64";
  if (!opts.altKey) return opts.configured;
  return opts.configured === "file" ? "base64" : "file";
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

/** 由扩展名推断图片 MIME，未知回退 image/png */
export function mimeForImageExt(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase().replace(/^\./, "")] ?? "image/png";
}

/** 图片字节 → `data:<mime>;base64,...` */
export function bytesToDataUri(bytes: Uint8Array, ext: string): string {
  // 分块拼接，避免 String.fromCharCode 一次性展开大数组导致堆栈溢出
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bytes.length);
    binary += String.fromCharCode(...bytes.subarray(i, end));
  }
  return `data:${mimeForImageExt(ext)};base64,${btoa(binary)}`;
}

export function useImagePaste(options: UseImagePasteOptions): UseImagePaste {
  const { getEditorView, getWorkspacePath, getCurrentFilePath, getInsertMode, getImageDir } =
    options;

  /**
   * 在编辑器插入 markdown 图片引用
   * @param pos 插入位置（拖放的落点）；省略/取不到时用当前光标
   */
  function insertMarkdownImage(view: EditorView, path: string, pos?: number | null): void {
    const markdown = `![](${path})`;
    const at = typeof pos === "number" ? pos : view.state.selection.main.head;
    view.dispatch({
      changes: { from: at, to: at, insert: markdown },
      selection: { anchor: at + 2, head: at + 2 }, // 光标放在 [] 内
    });
    view.focus();
  }

  /**
   * 按插入方式落图：file → 写入工作区目录后插相对路径；base64 → 直接内嵌。
   * file 模式下落盘失败（目录不可写等）回退内嵌，避免静默丢图。
   */
  async function insertImageBytes(
    view: EditorView,
    bytes: Uint8Array,
    ext: string,
    altKey: boolean,
    pos?: number | null
  ): Promise<boolean> {
    const workspace = getWorkspacePath();
    const mode = resolveInsertMode({
      configured: getInsertMode(),
      altKey,
      hasWorkspace: Boolean(workspace),
    });

    if (mode === "base64") {
      insertMarkdownImage(view, bytesToDataUri(bytes, ext), pos);
      return true;
    }

    try {
      const result = await invoke<{
        absolutePath: string;
        relativePath: string;
        filename: string;
      }>("save_image_asset", {
        workspace,
        // 将 Uint8Array 转为 number[] 以匹配 Rust 的 Vec<u8>
        bytes: Array.from(bytes),
        ext,
        dir: getImageDir(),
      });
      insertMarkdownImage(view, result.relativePath, pos);
      return true;
    } catch (err) {
      console.warn("保存图片到工作区失败，回退为内嵌 Base64:", err);
      insertMarkdownImage(view, bytesToDataUri(bytes, ext), pos);
      return true;
    }
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
    const view = getEditorView();
    if (!view) return false;

    const extracted = await extractImageBytes(e);
    if (!extracted) return false;

    // 粘贴没有坐标，插入在当前光标处；Alt 用键盘跟踪的状态（见 setup）
    return insertImageBytes(view, extracted.bytes, extracted.ext, altPressed);
  }

  async function handleDrop(e: DragEvent): Promise<boolean> {
    const view = getEditorView();
    if (!view) return false;

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return false;

    // 仅处理第一个图片文件（类型判定统一走 utils/fileKind，issue #151 起不再自建扩展名表）
    const file = files[0];
    if (!isImageFile(file.name)) return false;
    const ext = extname(file.name) || IMAGE_EXT_FALLBACK;

    const bytes = new Uint8Array(await file.arrayBuffer());
    e.preventDefault();

    // 插入点取**落点**；坐标不可用（编辑器未挂载/被遮挡）时回退当前光标
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    return insertImageBytes(view, bytes, ext, e.altKey, pos);
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
  let altDownHandler: ((e: KeyboardEvent) => void) | null = null;
  let altUpHandler: ((e: KeyboardEvent) => void) | null = null;

  /**
   * Alt 是否按下。
   *
   * `ClipboardEvent` 不带修饰键信息（它不继承 `MouseEvent`，没有 `altKey`），
   * 所以粘贴路径只能自己跟踪键盘状态；Drop 事件（`DragEvent extends MouseEvent`）
   * 直接用 `e.altKey`，不需要这个。
   */
  let altPressed = false;

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
    altDownHandler = (e: KeyboardEvent) => {
      if (e.key === "Alt") altPressed = true;
    };
    altUpHandler = (e: KeyboardEvent) => {
      if (e.key === "Alt") altPressed = false;
    };
    // 监听 window 级 paste 事件（编辑器宿主元素）
    window.addEventListener("paste", pasteHandler);
    window.addEventListener("drop", dropHandler);
    window.addEventListener("keydown", altDownHandler);
    window.addEventListener("keyup", altUpHandler);
    // 失焦时按键状态不可靠（Alt+Tab 切走不会收到 keyup），复位避免下一次粘贴被误判
    window.addEventListener("blur", resetAltState);
  }

  function resetAltState(): void {
    altPressed = false;
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
    if (altDownHandler) {
      window.removeEventListener("keydown", altDownHandler);
      altDownHandler = null;
    }
    if (altUpHandler) {
      window.removeEventListener("keyup", altUpHandler);
      altUpHandler = null;
    }
    window.removeEventListener("blur", resetAltState);
  }

  return {
    setup,
    teardown,
    handlePaste,
    handleDrop,
    insertExistingImage,
  };
}
