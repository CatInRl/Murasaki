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
import { save as saveDialog } from "@tauri-apps/plugin-dialog";

const mockedExportHtml = exportHtml as unknown as ReturnType<typeof vi.fn>;
const mockedExportPdf = fileSystem.exportPdf as unknown as ReturnType<typeof vi.fn>;
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
      openWorkspace: vi.fn(),
      hasWorkspace: true,
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
    } as never,
    activeTab: { value: makeTab() },
    currentTheme: ref("github"),
    ...overrides,
  } as never;
}

beforeEach(() => {
  mockedExportHtml.mockReset();
  mockedExportPdf.mockReset();
  mockedSaveDialog.mockReset();
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
