import { describe, it, expect, beforeEach, vi } from "vitest";
import { ref } from "vue";
import {
  useCopyRichText,
  extractRichTextFragment,
  type CopyRichTextDeps,
} from "./useCopyRichText";
import type { Tab } from "../types";

// mock exportHtml（避免触发 markdown-it / shiki 真实渲染）
vi.mock("./useHtmlExport", () => ({
  exportHtml: vi.fn(),
}));

import { exportHtml } from "./useHtmlExport";

const mockedExportHtml = exportHtml as unknown as ReturnType<typeof vi.fn>;

// mock ClipboardItem / navigator.clipboard / Blob
const mockWrite = vi.fn();
/** 捕获 Blob 构造的文本内容，供断言读取（jsdom Blob 无 text()/arrayBuffer()） */
const blobTexts: Blob[] = [];
beforeEach(() => {
  mockedExportHtml.mockReset();
  mockWrite.mockReset();
  blobTexts.length = 0;
  // 用 spy 包装原生 Blob，捕获构造参数便于断言
  const NativeBlob = globalThis.Blob;
  const BlobSpy = vi.fn((parts: BlobPart[], options?: BlobPropertyBag) => {
    const blob = new NativeBlob(parts, options);
    // 在 blob 上挂载 parts 快照，供测试读取
    Object.defineProperty(blob, "__parts", { value: parts });
    blobTexts.push(blob);
    return blob;
  });
  (BlobSpy as never as { prototype: unknown }).prototype = NativeBlob.prototype;
  globalThis.Blob = BlobSpy as never;
  // 注入全局 ClipboardItem + navigator.clipboard
  (globalThis as never as { ClipboardItem: unknown }).ClipboardItem = class {
    items: Record<string, Blob>;
    constructor(items: Record<string, Blob>) {
      this.items = items;
    }
  };
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { write: mockWrite },
    configurable: true,
  });
});

/** 读取 Blob 的文本内容（通过 spy 捕获的 parts） */
function blobText(blob: Blob): string {
  const parts = (blob as never as { __parts: BlobPart[] }).__parts;
  return parts.map((p) => String(p)).join("");
}

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "tab1",
    path: "/test/file.md",
    content: "# Hello\n\nworld",
    savedContent: "# Hello\n\nworld",
    lastMtime: null,
    isDirty: false,
    hasExternalChange: false,
    cursor: { line: 1, ch: 0 },
    scroll: { x: 0, y: 0 },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<CopyRichTextDeps> = {}): CopyRichTextDeps {
  return {
    activeTab: { value: makeTab() },
    currentTheme: ref("github"),
    workspace: { workspacePath: "/test" },
    toast: {
      success: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  } as never;
}

describe("extractRichTextFragment", () => {
  it("从完整 HTML 提取 <style> + <body> 内容", () => {
    const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head><style>.a { color: red; }</style></head>
<body class="markdown-body" data-md-theme="github">
<h1>Hello</h1>
</body>
</html>`;
    const fragment = extractRichTextFragment(fullHtml);
    expect(fragment).toContain("<style>.a { color: red; }</style>");
    expect(fragment).toContain('<h1>Hello</h1>');
    expect(fragment).not.toContain("<html");
    expect(fragment).not.toContain("<head>");
    expect(fragment).not.toContain("</body>");
    expect(fragment).not.toContain("<!DOCTYPE");
  });

  it("无 <body> 标签时回退为原文", () => {
    const html = "<p>no body tag</p>";
    const fragment = extractRichTextFragment(html);
    expect(fragment).toBe("<p>no body tag</p>");
  });

  it("无 <style> 标签时仅返回 body 内容", () => {
    const fullHtml = `<html><head></head><body><p>content</p></body></html>`;
    const fragment = extractRichTextFragment(fullHtml);
    expect(fragment).toBe("<p>content</p>");
  });
});

describe("useCopyRichText - copyRichText", () => {
  it("无激活 tab → toast error，不调用 exportHtml", async () => {
    const deps = makeDeps({ activeTab: { value: null } });
    const { copyRichText } = useCopyRichText(deps);
    await copyRichText();
    expect(deps.toast.error).toHaveBeenCalledWith("请先打开一个文件");
    expect(mockedExportHtml).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("成功 → 写入剪贴板 text/html + text/plain，toast success", async () => {
    const fullHtml = `<html><head><style>.a{color:red}</style></head><body><h1>Hi</h1></body></html>`;
    mockedExportHtml.mockResolvedValue(fullHtml);
    mockWrite.mockResolvedValue(undefined);

    const deps = makeDeps();
    const { copyRichText } = useCopyRichText(deps);
    await copyRichText();

    // exportHtml 被调用，参数正确
    expect(mockedExportHtml).toHaveBeenCalledWith({
      source: "# Hello\n\nworld",
      theme: "github",
      workspacePath: "/test",
      filePath: "/test/file.md",
    });
    // clipboard.write 被调用一次
    expect(mockWrite).toHaveBeenCalledTimes(1);
    const clipboardItem = mockWrite.mock.calls[0][0][0];
    // 包含 text/html 和 text/plain 两个 MIME
    expect(clipboardItem.items["text/html"]).toBeInstanceOf(Blob);
    expect(clipboardItem.items["text/plain"]).toBeInstanceOf(Blob);
    // text/html 内容是提取后的片段（含 style，不含 html/head/body 标签）
    const htmlBlob = clipboardItem.items["text/html"] as Blob;
    const htmlText = blobText(htmlBlob);
    expect(htmlText).toContain("<style>.a{color:red}</style>");
    expect(htmlText).toContain("<h1>Hi</h1>");
    expect(htmlText).not.toContain("<html");
    // text/plain 内容是 markdown 源码
    const plainBlob = clipboardItem.items["text/plain"] as Blob;
    const plainText = blobText(plainBlob);
    expect(plainText).toBe("# Hello\n\nworld");
    // toast success
    expect(deps.toast.success).toHaveBeenCalledWith("已复制富文本到剪贴板");
  });

  it("exportHtml 抛错 → toast error，不写剪贴板", async () => {
    mockedExportHtml.mockRejectedValue(new Error("render fail"));
    const deps = makeDeps();
    const { copyRichText } = useCopyRichText(deps);
    await copyRichText();
    expect(deps.toast.error).toHaveBeenCalledWith("复制富文本失败: Error: render fail");
    expect(mockWrite).not.toHaveBeenCalled();
    expect(deps.toast.success).not.toHaveBeenCalled();
  });

  it("clipboard.write 抛错 → toast error", async () => {
    mockedExportHtml.mockResolvedValue("<body><p>ok</p></body>");
    mockWrite.mockRejectedValue(new Error("clipboard denied"));
    const deps = makeDeps();
    const { copyRichText } = useCopyRichText(deps);
    await copyRichText();
    expect(deps.toast.error).toHaveBeenCalledWith("复制富文本失败: Error: clipboard denied");
    expect(deps.toast.success).not.toHaveBeenCalled();
  });

  it("无标题 tab（path=null）也能复制", async () => {
    mockedExportHtml.mockResolvedValue("<body><p>untitled</p></body>");
    mockWrite.mockResolvedValue(undefined);
    const deps = makeDeps({
      activeTab: { value: makeTab({ path: null, content: "untitled content" }) },
    });
    const { copyRichText } = useCopyRichText(deps);
    await copyRichText();
    expect(mockedExportHtml).toHaveBeenCalledWith({
      source: "untitled content",
      theme: "github",
      workspacePath: "/test",
      filePath: null,
    });
    expect(deps.toast.success).toHaveBeenCalled();
  });
});
