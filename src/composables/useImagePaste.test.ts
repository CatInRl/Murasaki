import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EditorView } from "@codemirror/view";

// ===== Mock @tauri-apps/api/core（insertDroppedImages 会调用 Rust 命令）=====
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  relativePath,
  resolveInsertMode,
  mimeForImageExt,
  bytesToDataUri,
  useImagePaste,
} from "./useImagePaste";

const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

/**
 * 最小 view 替身：`insertMarkdownImage` / `insertExistingImage` 只用到
 * `state.selection.main.head`、`dispatch`、`focus`
 */
function fakeView(
  head = 0,
  posAtCoords: (coords: { x: number; y: number }) => number | null = () => 0
): {
  view: EditorView;
  dispatch: ReturnType<typeof vi.fn>;
  posAtCoords: ReturnType<typeof vi.fn>;
} {
  const dispatch = vi.fn();
  const posAtCoordsFn = vi.fn(posAtCoords);
  const view = {
    state: { selection: { main: { head } } },
    dispatch,
    focus: vi.fn(),
    posAtCoords: posAtCoordsFn,
  } as unknown as EditorView;
  return { view, dispatch, posAtCoords: posAtCoordsFn };
}

beforeEach(() => {
  mockedInvoke.mockReset();
});

describe("useImagePaste utilities", () => {
  describe("insertExistingImage（文件树拖入：不复制、不受插入方式影响）", () => {
    function makePaste(head: number, mode: "file" | "base64") {
      const { view, dispatch } = fakeView(head);
      const paste = useImagePaste({
        getEditorView: () => view,
        getWorkspacePath: () => "/ws",
        getCurrentFilePath: () => "/ws/docs/a.md",
        getInsertMode: () => mode,
        getImageDir: () => "assets/images",
      });
      return { paste, dispatch };
    }

    it("插入相对当前 md 文件的相对路径（不复制到 assets、不内嵌）", () => {
      const { paste, dispatch } = makePaste(5, "file");
      expect(paste.insertExistingImage("/ws/assets/pic.png")).toBe(true);
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          // 当前文件在 /ws/docs/ 下，故相对路径带 ../
          changes: { from: 5, to: 5, insert: "![](../assets/pic.png)" },
        })
      );
    });

    it("设置为 base64 时结果完全相同（文件树拖入不受插入方式影响）", () => {
      const { paste, dispatch } = makePaste(5, "base64");
      expect(paste.insertExistingImage("/ws/assets/pic.png")).toBe(true);
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          changes: { from: 5, to: 5, insert: "![](../assets/pic.png)" },
        })
      );
    });
  });

  describe("insertDroppedImages（外部拖入图片，issue #288）", () => {
    interface MakeOpts {
      mode?: "file" | "base64";
      workspace?: string | null;
      currentFile?: string | null;
      head?: number;
    }

    function makePaste(opts: MakeOpts = {}) {
      const { view, dispatch, posAtCoords } = fakeView(opts.head ?? 0, () => 7);
      const paste = useImagePaste({
        getEditorView: () => view,
        getWorkspacePath: () => (opts.workspace === undefined ? "/ws" : opts.workspace),
        getCurrentFilePath: () =>
          opts.currentFile === undefined ? "/ws/a.md" : opts.currentFile,
        getInsertMode: () => opts.mode ?? "file",
        getImageDir: () => "assets/images",
      });
      return { paste, dispatch, posAtCoords };
    }

    it("非图片路径 → 不处理（返回 false、不 invoke）", async () => {
      const { paste, dispatch } = makePaste();
      expect(await paste.insertDroppedImages(["/tmp/a.md", "/tmp/b.txt"])).toBe(false);
      expect(mockedInvoke).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("无编辑器 view → 返回 false", async () => {
      const paste = useImagePaste({
        getEditorView: () => null,
        getWorkspacePath: () => "/ws",
        getCurrentFilePath: () => "/ws/a.md",
        getInsertMode: () => "file",
        getImageDir: () => "assets/images",
      });
      expect(await paste.insertDroppedImages(["/tmp/pic.png"])).toBe(false);
      expect(mockedInvoke).not.toHaveBeenCalled();
    });

    it("file 模式：复制到工作区后插入相对当前 md 文件的路径", async () => {
      mockedInvoke.mockResolvedValue({
        absolutePath: "/ws/assets/images/20260726-153045-a1b2c3.png",
        relativePath: "assets/images/20260726-153045-a1b2c3.png",
        filename: "20260726-153045-a1b2c3.png",
      });
      const { paste, dispatch } = makePaste({ mode: "file" });
      expect(await paste.insertDroppedImages(["/tmp/pic.png"])).toBe(true);

      expect(mockedInvoke).toHaveBeenCalledWith("copy_image_to_workspace", {
        sourcePath: "/tmp/pic.png",
        workspace: "/ws",
        dir: "assets/images",
      });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          changes: {
            from: 0,
            to: 0,
            insert: "![](assets/images/20260726-153045-a1b2c3.png)",
          },
        })
      );
    });

    it("file 模式：当前 md 在子目录时算相对路径（带 ../）", async () => {
      mockedInvoke.mockResolvedValue({
        absolutePath: "/ws/assets/images/x.png",
        relativePath: "assets/images/x.png",
        filename: "x.png",
      });
      const { paste, dispatch } = makePaste({ mode: "file", currentFile: "/ws/docs/a.md" });
      await paste.insertDroppedImages(["/tmp/pic.png"]);
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          changes: { from: 0, to: 0, insert: "![](../assets/images/x.png)" },
        })
      );
    });

    it("base64 模式：读取字节内嵌，不落盘", async () => {
      mockedInvoke.mockResolvedValue("Zm9v");
      const { paste, dispatch } = makePaste({ mode: "base64" });
      expect(await paste.insertDroppedImages(["/tmp/pic.png"])).toBe(true);

      expect(mockedInvoke).toHaveBeenCalledWith("read_image_base64", { sourcePath: "/tmp/pic.png" });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          changes: { from: 0, to: 0, insert: "![](data:image/png;base64,Zm9v)" },
        })
      );
    });

    it("无工作区：即使配置 file 也回退 base64", async () => {
      mockedInvoke.mockResolvedValue("Zm9v");
      const { paste, dispatch } = makePaste({ mode: "file", workspace: null });
      await paste.insertDroppedImages(["/tmp/pic.png"]);
      expect(mockedInvoke).toHaveBeenCalledWith("read_image_base64", { sourcePath: "/tmp/pic.png" });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          changes: { from: 0, to: 0, insert: "![](data:image/png;base64,Zm9v)" },
        })
      );
    });

    it("file 落盘失败 → 回退内嵌 base64", async () => {
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === "copy_image_to_workspace") return Promise.reject(new Error("boom"));
        return Promise.resolve("Zm9v");
      });
      const { paste, dispatch } = makePaste({ mode: "file" });
      await paste.insertDroppedImages(["/tmp/pic.png"]);
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          changes: { from: 0, to: 0, insert: "![](data:image/png;base64,Zm9v)" },
        })
      );
    });

    it("一次拖入多张：按顺序、用换行分隔，只插入一次 dispatch", async () => {
      // 每张返回不同文件名
      let n = 0;
      mockedInvoke.mockImplementation(() =>
        Promise.resolve({
          absolutePath: `/ws/assets/images/img${++n}.png`,
          relativePath: `assets/images/img${n}.png`,
          filename: `img${n}.png`,
        })
      );
      const { paste, dispatch } = makePaste({ mode: "file" });
      expect(await paste.insertDroppedImages(["/tmp/a.png", "/tmp/b.jpg"])).toBe(true);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          changes: {
            from: 0,
            to: 0,
            insert: "![](assets/images/img1.png)\n![](assets/images/img2.png)",
          },
        })
      );
    });

    it("落点有效：posAtCoords 用换算后的视口坐标，插入在落点", async () => {
      mockedInvoke.mockResolvedValue({
        absolutePath: "/ws/assets/images/x.png",
        relativePath: "assets/images/x.png",
        filename: "x.png",
      });
      const { paste, dispatch, posAtCoords } = makePaste({ mode: "file" });
      await paste.insertDroppedImages(["/tmp/pic.png"], { x: 400, y: 400 });
      // jsdom 默认 devicePixelRatio = 1 → (400-8, 400-31)
      expect(posAtCoords).toHaveBeenCalledWith({ x: 392, y: 369 });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ changes: { from: 7, to: 7, insert: "![](assets/images/x.png)" } })
      );
    });

    it("落点无效（坐标为 0）→ 回退当前光标，不调 posAtCoords", async () => {
      mockedInvoke.mockResolvedValue({
        absolutePath: "/ws/assets/images/x.png",
        relativePath: "assets/images/x.png",
        filename: "x.png",
      });
      const { paste, dispatch, posAtCoords } = makePaste({ mode: "file", head: 3 });
      await paste.insertDroppedImages(["/tmp/pic.png"], { x: 0, y: 0 });
      expect(posAtCoords).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ changes: { from: 3, to: 3, insert: "![](assets/images/x.png)" } })
      );
    });

    it("按住 Alt 时临时取反（配置 file → 内嵌 base64）", async () => {
      mockedInvoke.mockResolvedValue("Zm9v");
      const { paste, dispatch } = makePaste({ mode: "file" });
      paste.setup();
      try {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt" }));
        await paste.insertDroppedImages(["/tmp/pic.png"]);
        expect(mockedInvoke).toHaveBeenCalledWith("read_image_base64", {
          sourcePath: "/tmp/pic.png",
        });
        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            changes: { from: 0, to: 0, insert: "![](data:image/png;base64,Zm9v)" },
          })
        );
      } finally {
        paste.teardown();
      }
    });
  });

  describe("resolveInsertMode（issue #151 插入方式策略）", () => {
    it("无工作区一律回退 base64（file 模式无法落盘）", () => {
      expect(resolveInsertMode({ configured: "file", hasWorkspace: false })).toBe("base64");
      // 已有配置也不会改变结论
      expect(resolveInsertMode({ configured: "base64", hasWorkspace: false })).toBe("base64");
      // Alt 也救不了：没有工作区就是内嵌
      expect(
        resolveInsertMode({ configured: "file", altKey: true, hasWorkspace: false })
      ).toBe("base64");
    });

    it("有工作区时按配置走", () => {
      expect(resolveInsertMode({ configured: "file", hasWorkspace: true })).toBe("file");
      expect(resolveInsertMode({ configured: "base64", hasWorkspace: true })).toBe("base64");
    });

    it("Alt 临时取反（不改设置）", () => {
      expect(resolveInsertMode({ configured: "file", altKey: true, hasWorkspace: true })).toBe(
        "base64"
      );
      expect(resolveInsertMode({ configured: "base64", altKey: true, hasWorkspace: true })).toBe(
        "file"
      );
    });
  });

  describe("mimeForImageExt", () => {
    it("按扩展名推断 MIME", () => {
      expect(mimeForImageExt("png")).toBe("image/png");
      expect(mimeForImageExt("jpg")).toBe("image/jpeg");
      expect(mimeForImageExt("jpeg")).toBe("image/jpeg");
      expect(mimeForImageExt("gif")).toBe("image/gif");
      expect(mimeForImageExt("webp")).toBe("image/webp");
      expect(mimeForImageExt("bmp")).toBe("image/bmp");
      expect(mimeForImageExt("svg")).toBe("image/svg+xml");
    });

    it("大小写与前导点不敏感", () => {
      expect(mimeForImageExt("PNG")).toBe("image/png");
      expect(mimeForImageExt(".Jpg")).toBe("image/jpeg");
    });

    it("未知扩展名回退 image/png", () => {
      expect(mimeForImageExt("tiff")).toBe("image/png");
      expect(mimeForImageExt("")).toBe("image/png");
    });
  });

  describe("bytesToDataUri", () => {
    it("生成 data URI 且 Base64 可还原", () => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG 魔数前缀
      const uri = bytesToDataUri(bytes, "png");
      expect(uri.startsWith("data:image/png;base64,")).toBe(true);
      const payload = uri.slice("data:image/png;base64,".length);
      expect(Array.from(atob(payload), (c) => c.charCodeAt(0))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    });

    it("空字节也能生成合法 data URI", () => {
      expect(bytesToDataUri(new Uint8Array([]), "gif")).toBe("data:image/gif;base64,");
    });

    it("超过分块阈值（0x8000）不丢字节、不爆栈", () => {
      const size = 0x8000 * 2 + 17;
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = i % 256;
      const uri = bytesToDataUri(bytes, "webp");
      const payload = uri.slice("data:image/webp;base64,".length);
      const decoded = atob(payload);
      expect(decoded.length).toBe(size);
      expect(decoded.charCodeAt(size - 1)).toBe(bytes[size - 1]);
    });
  });

  describe("relativePath", () => {
    it("同目录文件", () => {
      const from = "/workspace/docs/intro.md";
      const to = "/workspace/docs/assets/img.png";
      const rel = relativePath(from, to);
      expect(rel).toBe("assets/img.png");
    });

    it("父目录中的文件", () => {
      const from = "/workspace/docs/sub/page.md";
      const to = "/workspace/docs/assets/img.png";
      const rel = relativePath(from, to);
      expect(rel).toBe("../assets/img.png");
    });

    it("跨多级目录", () => {
      const from = "/workspace/a/b/c/file.md";
      const to = "/workspace/x/y/img.png";
      const rel = relativePath(from, to);
      expect(rel).toBe("../../../x/y/img.png");
    });

    it("Windows 风格路径", () => {
      const from = "C:\\workspace\\docs\\intro.md";
      const to = "C:\\workspace\\docs\\assets\\img.png";
      const rel = relativePath(from, to);
      expect(rel).toBe("assets/img.png");
    });

    it("同一路径返回文件名", () => {
      const from = "/workspace/docs/intro.md";
      const to = "/workspace/docs/intro.md";
      const rel = relativePath(from, to);
      expect(rel).toBe("intro.md");
    });

    it("根目录下文件", () => {
      const from = "/workspace/root.md";
      const to = "/workspace/assets/img.png";
      const rel = relativePath(from, to);
      expect(rel).toBe("assets/img.png");
    });
  });
});
