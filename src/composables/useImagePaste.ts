import type { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { relativePath as computeRelativePath, extname } from "../utils/path";
import { toViewportCoords, type PhysicalPoint } from "../utils/dropPosition";
import type { ImageInsertMode } from "../types";

/**
 * 图片粘贴/拖入 composable
 *
 * 处理三种场景（spec：图片处理流程；issue #151 补「插入方式」策略，#288 修外部拖入）：
 * 1. 粘贴剪贴板图片 → 按插入方式处理
 * 2. 从系统拖入外部图片 → 按插入方式处理，插入点在**落点**（取不到坐标时回退光标）
 * 3. 从文件树拖入已存在图片 → 计算相对当前 md 文件的相对路径（不复制，不受插入方式影响）
 *
 * 其中场景 2 由 Tauri 原生 drag-drop 事件驱动（`useDragDrop` → `insertDroppedImages`）：
 * Tauri 的 `dragDropEnabled`（默认 true）会拦截系统文件拖放，HTML5 的 `drop` 收不到系统
 * 文件拖放，故这里**不再**监听 window 级 HTML5 `drop`（#288 前那条入口在 Windows 上一直失效）。
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
  /** 注册 paste 监听器（在 onMounted 中调用） */
  setup(): void;
  /** 移除监听器（在 onBeforeUnmount 中调用） */
  teardown(): void;
  /**
   * 处理粘贴事件：检测剪贴板是否含图片，若有则保存到 assets 并插入 markdown
   * 返回 true 表示已处理（应阻止默认粘贴行为）
   */
  handlePaste(e: ClipboardEvent): Promise<boolean>;
  /**
   * 处理 Tauri 原生拖放带来的外部图片路径（issue #288）：
   * 按 `paths` 顺序逐张按插入方式落图/内嵌，并插入到 `position`（物理像素落点）对应的位置，
   * 取不到坐标时回退到当前光标。返回 true 表示至少插入了一张。
   */
  insertDroppedImages(paths: string[], position?: PhysicalPoint | null): Promise<boolean>;
  /**
   * 从文件树拖入已有图片：使用相对当前 md 文件的路径写法（不复制）
   */
  insertExistingImage(absolutePath: string): boolean;
}

/** Rust `copy_image_to_workspace` 的返回结构 */
interface SaveImageResult {
  absolutePath: string;
  relativePath: string;
  filename: string;
}

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
   * 在编辑器插入一段 markdown
   * @param pos 插入位置（拖放的落点）；省略/取不到时用当前光标
   */
  function insertMarkdown(view: EditorView, markdown: string, pos?: number | null): void {
    const at = typeof pos === "number" ? pos : view.state.selection.main.head;
    view.dispatch({
      changes: { from: at, to: at, insert: markdown },
      selection: { anchor: at + 2, head: at + 2 }, // 光标放在 [] 内
    });
    view.focus();
  }

  /** 在编辑器插入 markdown 图片引用 `![](path)` */
  function insertMarkdownImage(view: EditorView, path: string, pos?: number | null): void {
    insertMarkdown(view, `![](${path})`, pos);
  }

  /**
   * 落盘后的绝对路径 → markdown 引用串：统一相对**当前 md 文件**（无当前文件时用绝对路径）。
   *
   * 这是「相对当前文件」口径的唯一出处 —— 粘贴、文件树拖入、原生拖入三条入口共用，
   * 避免同一张图经不同入口插入得到不同形式的链接（issue #288 审查）。
   */
  function refFromAbsolutePath(absolutePath: string): string {
    const currentFile = getCurrentFilePath();
    return currentFile ? relativePath(currentFile, absolutePath) : absolutePath;
  }

  /**
   * 按插入方式落图并生成引用串 —— **粘贴与原生拖入两条入口共用**（issue #288 审查）。
   *
   * 统一口径：file → 落盘到工作区后用 `refFromAbsolutePath`（相对当前 md 文件）引用；
   * base64（含无工作区、Alt 取反）→ 内嵌 data URI；file 落盘失败 → 回退内嵌，避免静默丢图。
   *
   * 两条入口的差异只体现在「字节从哪来」：`persist` 怎么落盘（粘贴给字节 / 原生拖入给绝对
   * 路径）、`readAsBase64` 怎么取内嵌串；落点坐标由调用方各自处理。
   *
   * @param altKey 是否按住 Alt（本次临时取反插入方式）
   * @param persist file 模式：把图片落盘到工作区，返回落盘后的**绝对路径**
   * @param readAsBase64 base64 模式（或 file 落盘失败回退）：取内嵌 data URI；取不到返回 null
   * @returns 引用串（相对路径或 data URI）；取不到时返回 null（调用方跳过该张）
   */
  async function persistAndBuildRef(opts: {
    altKey: boolean;
    persist: () => Promise<string>;
    readAsBase64: () => Promise<string | null>;
  }): Promise<string | null> {
    const mode = resolveInsertMode({
      configured: getInsertMode(),
      altKey: opts.altKey,
      hasWorkspace: Boolean(getWorkspacePath()),
    });

    if (mode === "base64") return opts.readAsBase64();

    try {
      return refFromAbsolutePath(await opts.persist());
    } catch (err) {
      console.warn("保存图片到工作区失败，回退为内嵌 Base64:", err);
      return opts.readAsBase64();
    }
  }

  /**
   * 按插入方式落「字节」：file → 写入工作区目录后插相对**当前 md 文件**的路径；
   * base64 → 直接内嵌；落盘失败回退内嵌。
   */
  async function insertImageBytes(
    view: EditorView,
    bytes: Uint8Array,
    ext: string,
    altKey: boolean,
    pos?: number | null
  ): Promise<boolean> {
    const ref = await persistAndBuildRef({
      altKey,
      persist: async () => {
        const result = await invoke<SaveImageResult>("save_image_asset", {
          workspace: getWorkspacePath(),
          // 将 Uint8Array 转为 number[] 以匹配 Rust 的 Vec<u8>
          bytes: Array.from(bytes),
          ext,
          dir: getImageDir(),
        });
        return result.absolutePath;
      },
      readAsBase64: async () => bytesToDataUri(bytes, ext),
    });
    if (!ref) return false;
    insertMarkdownImage(view, ref, pos);
    return true;
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

  /** 读取本地图片文件字节并转为 data URI（走 Rust，前端不直接读文件）；失败返回 null */
  async function readAsDataUri(path: string): Promise<string | null> {
    try {
      const base64 = await invoke<string>("read_image_base64", { sourcePath: path });
      return `data:${mimeForImageExt(extname(path))};base64,${base64}`;
    } catch (err) {
      console.warn("读取拖入图片失败，跳过:", err);
      return null;
    }
  }

  /**
   * 把单张拖入的图片落盘/内嵌为引用串（不含 `![]()` 外壳），复用与粘贴同一套插入方式逻辑。
   *
   * 与粘贴的唯一差异：图片来源是**绝对路径**（原生拖入 payload 只给路径），故 file 模式走
   * `copy_image_to_workspace`；base64 模式走 `read_image_base64`。
   */
  async function droppedImageRef(path: string, altKey: boolean): Promise<string | null> {
    return persistAndBuildRef({
      altKey,
      persist: async () => {
        const result = await invoke<SaveImageResult>("copy_image_to_workspace", {
          sourcePath: path,
          workspace: getWorkspacePath(),
          dir: getImageDir(),
        });
        return result.absolutePath;
      },
      readAsBase64: () => readAsDataUri(path),
    });
  }

  async function insertDroppedImages(
    paths: string[],
    position?: PhysicalPoint | null
  ): Promise<boolean> {
    const view = getEditorView();
    if (!view) return false;

    // paths 已由 `dropPlan.planDrop` 单列为图片（`DropPlan.images`），这里不再重复
    // `isImageFile` 过滤（issue #288 审查）；且本方法只被原生拖放入口调用，不含其它入口。
    // Alt 在拖放事件里拿不到修饰键信息（payload 只带 paths/position），用键盘跟踪状态，
    // 且在整批处理前取一次快照，保证一次拖入多张时方式一致
    const altKey = altPressed;
    const refs: string[] = [];
    for (const path of paths) {
      const ref = await droppedImageRef(path, altKey);
      if (ref) refs.push(`![](${ref})`);
    }
    if (refs.length === 0) return false;

    const coords = toViewportCoords(position ?? null, window.devicePixelRatio);
    const pos = coords ? view.posAtCoords(coords) : null;
    // 多张按顺序插入：一次插入整块，避免后插的落到前一张的 alt 文本里
    insertMarkdown(view, refs.join("\n"), pos);
    return true;
  }

  /**
   * 从文件树拖入已有图片：使用相对当前 md 文件的路径写法（不复制）
   */
  function insertExistingImage(absolutePath: string): boolean {
    const view = getEditorView();
    if (!view) return false;
    insertMarkdownImage(view, refFromAbsolutePath(absolutePath));
    return true;
  }

  // 监听器引用，便于卸载
  let pasteHandler: ((e: ClipboardEvent) => void) | null = null;
  let altDownHandler: ((e: KeyboardEvent) => void) | null = null;
  let altUpHandler: ((e: KeyboardEvent) => void) | null = null;

  /**
   * Alt 是否按下。
   *
   * `ClipboardEvent` 不带修饰键信息（它不继承 `MouseEvent`，没有 `altKey`），
   * Tauri 的 drag-drop payload 也不带修饰键，所以这两条链路只能自己跟踪键盘状态。
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
    altDownHandler = (e: KeyboardEvent) => {
      if (e.key === "Alt") altPressed = true;
    };
    altUpHandler = (e: KeyboardEvent) => {
      if (e.key === "Alt") altPressed = false;
    };
    // 监听 window 级 paste 事件（编辑器宿主元素）
    window.addEventListener("paste", pasteHandler);
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
    insertDroppedImages,
    insertExistingImage,
  };
}
