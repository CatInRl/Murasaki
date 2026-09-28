import { describe, it, expect, beforeEach, vi } from "vitest";
import { ref } from "vue";
import { useFileActions, type FileActionsDeps } from "./useFileActions";
import type { Tab } from "../types";

// mock exportHtml（避免触发 markdown-it / shiki 真实渲染）
vi.mock("./useHtmlExport", () => ({
  exportHtml: vi.fn(),
}));

// mock fileSystem（集中 Tauri 文件命令）
vi.mock("../services/fileSystem", () => ({
  fileSystem: {
    writeText: vi.fn(),
    exists: vi.fn().mockResolvedValue(false),
    getSize: vi.fn().mockResolvedValue(0),
    exportPdf: vi.fn(),
  },
}));

// mock @tauri-apps/plugin-dialog
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

import { exportHtml } from "./useHtmlExport";
import { fileSystem } from "../services/fileSystem";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

const mockedExportHtml = exportHtml as unknown as ReturnType<typeof vi.fn>;
const mockedExportPdf = fileSystem.exportPdf as unknown as ReturnType<typeof vi.fn>;
const mockedGetSize = fileSystem.getSize as unknown as ReturnType<typeof vi.fn>;
const mockedExists = fileSystem.exists as unknown as ReturnType<typeof vi.fn>;
const mockedOpenDialog = openDialog as unknown as ReturnType<typeof vi.fn>;
const mockedSaveDialog = saveDialog as unknown as ReturnType<typeof vi.fn>;

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

function makeDeps(overrides: Partial<FileActionsDeps> = {}): FileActionsDeps {
  return {
    tabsStore: {
      openFile: vi.fn().mockResolvedValue(undefined),
      saveTab: vi.fn().mockResolvedValue(undefined),
      saveTabAs: vi.fn().mockResolvedValue(undefined),
      reloadFromDisk: vi.fn().mockResolvedValue(undefined),
      newTab: vi.fn(),
    } as never,
    workspace: {
      workspacePath: "/test",
      selectFile: vi.fn(),
      openFolderDialog: vi.fn(),
      hasWorkspace: true,
    } as never,
    fileOps: {
      beginRootCreate: vi.fn(),
      openWithDefaultApp: vi.fn().mockResolvedValue(undefined),
    } as never,
    persistence: {
      addRecent: vi.fn().mockResolvedValue(undefined),
      removeRecent: vi.fn().mockResolvedValue(undefined),
    } as never,
    dialog: {
      alert: vi.fn(),
      confirm: vi.fn().mockResolvedValue(false),
    } as never,
    toast: {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    } as never,
    activeTab: { value: makeTab() },
    currentTheme: ref("github"),
    ...overrides,
  } as never;
}

beforeEach(() => {
  mockedExportHtml.mockReset();
  mockedExportPdf.mockReset();
  mockedOpenDialog.mockReset();
  mockedSaveDialog.mockReset();
  mockedGetSize.mockReset().mockResolvedValue(0);
  mockedExists.mockReset().mockResolvedValue(false);
});

describe("useFileActions - openFileViaDialog", () => {
  it("过滤器覆盖 Markdown / 文本与代码 / 所有文件三类", async () => {
    mockedOpenDialog.mockResolvedValue(null);
    const deps = makeDeps();
    const { openFileViaDialog } = useFileActions(deps);
    await openFileViaDialog();

    const options = mockedOpenDialog.mock.calls[0][0];
    expect(options.title).toBe("打开文件");
    expect(options.filters.map((f: { name: string }) => f.name)).toEqual([
      "Markdown 文档",
      "文本与代码文件",
      "所有文件",
    ]);
    expect(options.filters[0].extensions).toEqual(
      expect.arrayContaining(["md", "markdown", "mdown", "mkd"])
    );
    expect(options.filters[1].extensions).toEqual(
      expect.arrayContaining(["html", "txt", "json", "yaml", "py"])
    );
    expect(options.filters[2].extensions).toEqual(["*"]);
  });

  it("选中非 Markdown 文件也能打开", async () => {
    mockedOpenDialog.mockResolvedValue("/test/page.html");
    const deps = makeDeps();
    const { openFileViaDialog } = useFileActions(deps);
    await openFileViaDialog();

    expect(deps.tabsStore.openFile).toHaveBeenCalledWith("/test/page.html");
    expect(deps.persistence.addRecent).toHaveBeenCalledWith("/test/page.html", "file");
  });
});

/** 取 mock 化后的依赖句柄（deps 是结构化类型，断言需要 vi.fn 的具体形态） */
function asMock<T>(fn: T): ReturnType<typeof vi.fn> {
  return fn as unknown as ReturnType<typeof vi.fn>;
}

describe("useFileActions - openFile（#308 无后缀文件）", () => {
  it("无后缀小文件 → 不确认，直接打开", async () => {
    mockedGetSize.mockResolvedValue(1024);
    const deps = makeDeps();
    const { openFile } = useFileActions(deps);
    await openFile("/ws/Makefile");

    expect(deps.dialog.confirm).not.toHaveBeenCalled();
    expect(deps.tabsStore.openFile).toHaveBeenCalledWith("/ws/Makefile");
    expect(deps.persistence.addRecent).toHaveBeenCalledWith("/ws/Makefile", "file");
  });

  it("无后缀大文件 → 先确认，确认后打开", async () => {
    mockedGetSize.mockResolvedValue(2 * 1024 * 1024);
    const deps = makeDeps();
    asMock(deps.dialog.confirm).mockResolvedValue(true);
    const { openFile } = useFileActions(deps);
    await openFile("/ws/build-log");

    expect(deps.dialog.confirm).toHaveBeenCalledWith({
      message: expect.stringContaining("2.0 MB"),
    });
    expect(deps.tabsStore.openFile).toHaveBeenCalledWith("/ws/build-log");
  });

  it("无后缀大文件 → 用户取消则不打开、不记最近", async () => {
    mockedGetSize.mockResolvedValue(2 * 1024 * 1024);
    const deps = makeDeps(); // dialog.confirm 默认返回 false
    const { openFile } = useFileActions(deps);
    await openFile("/ws/build-log");

    expect(deps.dialog.confirm).toHaveBeenCalled();
    expect(deps.tabsStore.openFile).not.toHaveBeenCalled();
    expect(deps.persistence.addRecent).not.toHaveBeenCalled();
  });

  it("有后缀文件 → 不查大小也不确认（.log 等大文件行为不变）", async () => {
    const deps = makeDeps();
    const { openFile } = useFileActions(deps);
    await openFile("/ws/huge.log");

    expect(mockedGetSize).not.toHaveBeenCalled();
    expect(deps.dialog.confirm).not.toHaveBeenCalled();
    expect(deps.tabsStore.openFile).toHaveBeenCalledWith("/ws/huge.log");
  });

  it("文件在但读不出来 → toast.error 带「用系统默认程序打开」兜底", async () => {
    mockedGetSize.mockResolvedValue(1024);
    mockedExists.mockResolvedValue(true);
    const deps = makeDeps();
    asMock(deps.tabsStore.openFile).mockRejectedValue(
      new Error("stream did not contain valid UTF-8")
    );
    const fallback = asMock(deps.fileOps.openWithDefaultApp);
    const { openFile } = useFileActions(deps);
    await openFile("/ws/raw-binary");

    expect(deps.dialog.alert).not.toHaveBeenCalled();
    const [title, opts] = asMock(deps.toast.error).mock.calls[0];
    expect(title).toContain("打开文件失败");
    expect(opts.action.label).toBe("用系统默认程序打开");

    opts.action.onClick();
    expect(fallback).toHaveBeenCalledWith("/ws/raw-binary");
  });

  it("兜底本身也失败 → 弹对话框说明原因", async () => {
    mockedGetSize.mockResolvedValue(1024);
    mockedExists.mockResolvedValue(true);
    const deps = makeDeps();
    asMock(deps.tabsStore.openFile).mockRejectedValue(new Error("read fail"));
    asMock(deps.fileOps.openWithDefaultApp).mockRejectedValue(new Error("no handler"));
    const { openFile } = useFileActions(deps);
    await openFile("/ws/raw-binary");

    asMock(deps.toast.error).mock.calls[0][1].action.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deps.dialog.alert).toHaveBeenCalledWith({
      message: expect.stringContaining("无法用系统默认程序打开"),
      variant: "error",
    });
  });

  it("文件不存在 → 仍是「从最近打开中移除」确认（行为不变）", async () => {
    const deps = makeDeps(); // fileSystem.exists 默认 false
    asMock(deps.tabsStore.openFile).mockRejectedValue(new Error("文件不存在"));
    const { openFile } = useFileActions(deps);
    await openFile("/ws/gone.md");

    expect(deps.dialog.confirm).toHaveBeenCalledWith({
      message: expect.stringContaining("gone.md"),
      danger: true,
    });
    expect(deps.toast.error).not.toHaveBeenCalled();
  });
});

describe("useFileActions - notifyUnsupportedDropFiles（#317 拖入打不开的文件）", () => {
  it("恰好 1 个 → 提示计数并附「用系统默认程序打开」动作，点动作走同一兜底出口", () => {
    const deps = makeDeps();
    const { notifyUnsupportedDropFiles } = useFileActions(deps);
    notifyUnsupportedDropFiles(["/ws/manual.pdf"]);

    const [title, opts] = asMock(deps.toast.info).mock.calls[0];
    expect(title).toBe("已忽略 1 个无法打开的文件");
    expect(opts.action.label).toBe("用系统默认程序打开");

    opts.action.onClick();
    expect(deps.fileOps.openWithDefaultApp).toHaveBeenCalledWith("/ws/manual.pdf");
  });

  it("≥2 个 → 只报计数，不给动作（一个动作拉起 N 个外部程序太跳脱）", () => {
    const deps = makeDeps();
    const { notifyUnsupportedDropFiles } = useFileActions(deps);
    notifyUnsupportedDropFiles(["/ws/a.zip", "/ws/b.exe"]);

    const [title, opts] = asMock(deps.toast.info).mock.calls[0];
    expect(title).toBe("已忽略 2 个无法打开的文件");
    expect(opts.action).toBeUndefined();
    expect(deps.fileOps.openWithDefaultApp).not.toHaveBeenCalled();
  });
});

describe("useFileActions - exportCurrentPdf", () => {
  it("无激活 tab → dialog.alert 警告，不调用 exportHtml/exportPdf", async () => {
    const deps = makeDeps({ activeTab: { value: null } });
    const { exportCurrentPdf } = useFileActions(deps);
    await exportCurrentPdf();
    expect(deps.dialog.alert).toHaveBeenCalledWith({
      message: "请先打开一个文件",
      variant: "warning",
    });
    expect(mockedExportHtml).not.toHaveBeenCalled();
    expect(mockedExportPdf).not.toHaveBeenCalled();
  });

  it("成功 → saveDialog(PDF) + exportHtml + exportPdf + toast.success", async () => {
    const fullHtml = "<html><body><h1>Hi</h1></body></html>";
    mockedExportHtml.mockResolvedValue(fullHtml);
    mockedSaveDialog.mockResolvedValue("/test/file.pdf");
    mockedExportPdf.mockResolvedValue(undefined);

    const deps = makeDeps();
    const { exportCurrentPdf } = useFileActions(deps);
    await exportCurrentPdf();

    // saveDialog 用 PDF 过滤器
    expect(mockedSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ name: "PDF", extensions: ["pdf"] }],
        title: "导出 PDF",
      })
    );
    // exportHtml 被调用，参数正确
    expect(mockedExportHtml).toHaveBeenCalledWith({
      source: "# Hello\n\nworld",
      theme: "github",
      workspacePath: "/test",
      filePath: "/test/file.md",
    });
    // exportPdf 被调用，传 HTML + 路径
    expect(mockedExportPdf).toHaveBeenCalledWith(fullHtml, "/test/file.pdf");
    // toast success
    expect(deps.toast.success).toHaveBeenCalledWith("已导出 PDF");
  });

  it("用户取消 saveDialog → 不调用 exportHtml/exportPdf，无 toast", async () => {
    mockedSaveDialog.mockResolvedValue(null);

    const deps = makeDeps();
    const { exportCurrentPdf } = useFileActions(deps);
    await exportCurrentPdf();

    expect(mockedExportHtml).not.toHaveBeenCalled();
    expect(mockedExportPdf).not.toHaveBeenCalled();
    expect(deps.toast.success).not.toHaveBeenCalled();
    expect(deps.toast.error).not.toHaveBeenCalled();
  });

  it("exportHtml 抛错 → toast.error，不调用 exportPdf", async () => {
    mockedExportHtml.mockRejectedValue(new Error("render fail"));
    mockedSaveDialog.mockResolvedValue("/test/file.pdf");

    const deps = makeDeps();
    const { exportCurrentPdf } = useFileActions(deps);
    await exportCurrentPdf();

    expect(deps.toast.error).toHaveBeenCalledWith(
      expect.stringContaining("导出 PDF 失败")
    );
    expect(mockedExportPdf).not.toHaveBeenCalled();
    expect(deps.toast.success).not.toHaveBeenCalled();
  });

  it("exportPdf 抛错 → toast.error", async () => {
    const fullHtml = "<html><body><h1>Hi</h1></body></html>";
    mockedExportHtml.mockResolvedValue(fullHtml);
    mockedSaveDialog.mockResolvedValue("/test/file.pdf");
    mockedExportPdf.mockRejectedValue(new Error("PDF generation failed"));

    const deps = makeDeps();
    const { exportCurrentPdf } = useFileActions(deps);
    await exportCurrentPdf();

    expect(deps.toast.error).toHaveBeenCalledWith(
      expect.stringContaining("导出 PDF 失败")
    );
    expect(deps.toast.success).not.toHaveBeenCalled();
  });

  it("无标题 tab（path=null）也能导出，默认名 untitled.pdf", async () => {
    mockedExportHtml.mockResolvedValue("<body>ok</body>");
    mockedSaveDialog.mockResolvedValue("/test/untitled.pdf");
    mockedExportPdf.mockResolvedValue(undefined);

    const deps = makeDeps({
      activeTab: { value: makeTab({ path: null, content: "untitled" }) },
    });
    const { exportCurrentPdf } = useFileActions(deps);
    await exportCurrentPdf();

    expect(mockedSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: "untitled.pdf",
      })
    );
    expect(mockedExportHtml).toHaveBeenCalledWith({
      source: "untitled",
      theme: "github",
      workspacePath: "/test",
      filePath: null,
    });
    expect(mockedExportPdf).toHaveBeenCalled();
  });

  it("有路径的 tab 默认名用 basename 替换扩展名", async () => {
    mockedExportHtml.mockResolvedValue("<body>ok</body>");
    mockedSaveDialog.mockResolvedValue("/test/my-doc.pdf");
    mockedExportPdf.mockResolvedValue(undefined);

    const deps = makeDeps({
      activeTab: { value: makeTab({ path: "/workspace/my-doc.md" }) },
    });
    const { exportCurrentPdf } = useFileActions(deps);
    await exportCurrentPdf();

    expect(mockedSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: "my-doc.pdf",
      })
    );
  });
});
