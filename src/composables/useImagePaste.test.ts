import { describe, it, expect, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import {
  relativePath,
  resolveInsertMode,
  mimeForImageExt,
  bytesToDataUri,
  useImagePaste,
} from "./useImagePaste";

/**
 * 最小 view 替身：`insertMarkdownImage` / `insertExistingImage` 只用到
 * `state.selection.main.head`、`dispatch`、`focus`
 */
function fakeView(head = 0): { view: EditorView; dispatch: ReturnType<typeof vi.fn> } {
  const dispatch = vi.fn();
  const view = {
    state: { selection: { main: { head } } },
    dispatch,
    focus: vi.fn(),
  } as unknown as EditorView;
  return { view, dispatch };
}

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
