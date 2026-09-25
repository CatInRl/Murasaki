import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { basename } from "../utils/path";
import { exportHtml } from "./useHtmlExport";
import { fileSystem } from "../services/fileSystem";
import { EDITABLE_TEXT_EXTENSIONS, MARKDOWN_EXTENSIONS } from "../utils/fileKind";
import { i18n } from "../i18n";
import type { Ref } from "vue";
import type { Tab } from "../types";

/** useFileActions 依赖的 store/状态切片 */
export interface FileActionsDeps {
  tabsStore: {
    openFile: (path: string) => Promise<unknown>;
    saveTab: (id: string) => Promise<unknown>;
    saveTabAs: (id: string, path: string) => Promise<unknown>;
    reloadFromDisk: (path: string) => Promise<unknown>;
    newTab: (content: string) => void;
  };
  workspace: {
    workspacePath: string | null;
    selectFile: (path: string) => void;
    /** 选目录并**在新窗口**打开为工作区（spec #194 决策 ②） */
    openFolderDialog: () => Promise<unknown>;
    /** 有工作区时新建文件落文件树根目录（内联命名） */
    hasWorkspace: boolean;
  };
  /** 文件操作 store 切片（含文件树根目录内联新建状态） */
  fileOps: {
    beginRootCreate: (type: "file" | "directory") => void;
  };
  persistence: {
    addRecent: (path: string, type: "file" | "folder") => Promise<void>;
    removeRecent: (path: string) => Promise<void>;
  };
  dialog: {
    alert: (opts: { message: string; variant?: "info" | "warning" | "error"; title?: string }) => void;
    confirm: (opts: { message: string; danger?: boolean }) => Promise<boolean>;
  };
  /** toast 反馈（PDF 导出成功/失败提示） */
  toast: {
    success: (title: string) => void;
    error: (title: string) => void;
  };
  /** 当前激活 tab（computed 或 getter） */
  activeTab: { value: Tab | null };
  /** 当前主题（用于 HTML 导出） */
  currentTheme: Ref<string>;
}

/**
 * 文件操作：磁盘 IO 类入口（open/save/saveAs/export/reload/new/openFolder/openRecent）。
 *
 * 从 App.vue 提取，保持原有行为不变。
 */
export function useFileActions(deps: FileActionsDeps) {
  const { tabsStore, workspace, fileOps, persistence, dialog, toast, activeTab, currentTheme } = deps;
  const t = i18n.global.t.bind(i18n.global);

  /**
   * 在当前窗口打开文件为 tab。
   *
   * 注意：**不**自动把文件所在目录设为工作区（多窗口改造，spec #194 决策 ①）。
   * 旧行为会让「打开单个文件」污染当前窗口的工作区；现在无工作区时文件树保持空，
   * 需要工作区请走「打开文件夹」（会在新窗口中打开）。
   */
  async function openFile(path: string): Promise<void> {
    try {
      await tabsStore.openFile(path);
      workspace.selectFile(path);
      await persistence.addRecent(path, "file");
    } catch (err) {
      console.error("打开文件失败:", err);
      const exists = await fileSystem.exists(path);
      if (!exists) {
        const fileName = basename(path);
        const shouldRemove = await dialog.confirm({
          message: t("common.dialog.fileNotFoundRemove", { name: fileName }),
          danger: true,
        });
        if (shouldRemove) {
          await persistence.removeRecent(path);
        }
      } else {
        dialog.alert({ message: t("common.error.openFileFailed", { error: err }), variant: "error" });
      }
    }
  }

  async function openFileViaDialog(): Promise<void> {
    const selected = await openDialog({
      multiple: false,
      filters: [
        { name: t("common.fileFilter.markdown"), extensions: MARKDOWN_EXTENSIONS },
        { name: t("common.fileFilter.textCode"), extensions: EDITABLE_TEXT_EXTENSIONS },
        { name: t("common.fileFilter.allFiles"), extensions: ["*"] },
      ],
      title: t("common.openFileTitle"),
    });
    if (typeof selected === "string" && selected) {
      await openFile(selected);
    }
  }

  async function saveCurrentFile(): Promise<void> {
    if (!activeTab.value) return;
    if (!activeTab.value.path) {
      await saveAsCurrentFile();
      return;
    }
    try {
      await tabsStore.saveTab(activeTab.value.id);
    } catch (err) {
      console.error("保存失败:", err);
      dialog.alert({ message: t("common.error.saveFailed", { error: err }), variant: "error" });
    }
  }

  async function saveAsCurrentFile(): Promise<void> {
    if (!activeTab.value) return;
    const selected = await openDialog({
      directory: false,
      save: true,
      filters: [{ name: t("common.fileFilter.markdown"), extensions: MARKDOWN_EXTENSIONS }],
      title: t("common.saveAs"),
      defaultPath: workspace.workspacePath ?? undefined,
    });
    if (typeof selected === "string" && selected) {
      try {
        await tabsStore.saveTabAs(activeTab.value.id, selected);
        await persistence.addRecent(selected, "file");
      } catch (err) {
        console.error("另存为失败:", err);
        dialog.alert({ message: t("common.error.saveAsFailed", { error: err }), variant: "error" });
      }
    }
  }

  async function reloadCurrentFile(): Promise<void> {
    const path = activeTab.value?.path;
    if (!path) return;
    try {
      await tabsStore.reloadFromDisk(path);
    } catch (err) {
      console.error("重新加载失败:", err);
      dialog.alert({ message: t("common.error.reloadFailed", { error: err }), variant: "error" });
    }
  }

  async function exportCurrentHtml(): Promise<void> {
    if (!activeTab.value) {
      dialog.alert({ message: t("common.dialog.openFileFirst"), variant: "warning" });
      return;
    }
    const tab = activeTab.value;
    const defaultName = tab.path
      ? basename(tab.path).replace(/\.md$/i, "") + ".html"
      : "untitled.html";
    const selected = await saveDialog({
      defaultPath: defaultName,
      filters: [{ name: "HTML", extensions: ["html"] }],
      title: t("common.exportHtmlTitle"),
    });
    if (typeof selected !== "string" || !selected) return;
    try {
      const html = await exportHtml({
        source: tab.content,
        theme: currentTheme.value,
        workspacePath: workspace.workspacePath ?? null,
        filePath: tab.path,
      });
      await fileSystem.writeText(selected, html);
    } catch (err) {
      console.error("导出 HTML 失败:", err);
      dialog.alert({ message: t("common.error.exportHtmlFailed", { error: err }), variant: "error" });
    }
  }

  async function exportCurrentPdf(): Promise<void> {
    if (!activeTab.value) {
      dialog.alert({ message: t("common.dialog.openFileFirst"), variant: "warning" });
      return;
    }
    const tab = activeTab.value;
    const defaultName = tab.path
      ? basename(tab.path).replace(/\.md$/i, "") + ".pdf"
      : "untitled.pdf";
    const selected = await saveDialog({
      defaultPath: defaultName,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
      title: t("common.exportPdfTitle"),
    });
    if (typeof selected !== "string" || !selected) return;
    try {
      const html = await exportHtml({
        source: tab.content,
        theme: currentTheme.value,
        workspacePath: workspace.workspacePath ?? null,
        filePath: tab.path,
      });
      await fileSystem.exportPdf(html, selected);
      toast.success(t("common.exportPdfSuccess"));
    } catch (err) {
      console.error("导出 PDF 失败:", err);
      toast.error(t("common.error.exportPdfFailed", { error: err }));
    }
  }

  function onNewTab(): void {
    tabsStore.newTab("");
  }

  function onNewFile(): void {
    // 有工作区 → 落文件树根目录内联命名；无工作区 → 新建未命名 tab
    if (workspace.hasWorkspace) {
      fileOps.beginRootCreate("file");
    } else {
      onNewTab();
    }
  }

  /** 把路径交给新窗口打开（目录命中已有窗口时 Rust 侧会聚焦，不重复开窗） */
  async function openPathInNewWindow(path: string): Promise<void> {
    await invoke("open_path_in_new_window", { path });
  }

  function onOpenFolder(): void {
    // 多工作区 = 多窗口（spec #194 决策 ②）：打开文件夹一律新开窗口，
    // 统一由 workspace store 实现（选目录 + open_path_in_new_window）
    void workspace.openFolderDialog();
  }

  function onOpenFile(): void {
    void openFileViaDialog();
  }

  async function onOpenRecent(path: string, type: "file" | "folder"): Promise<void> {
    if (type === "folder") {
      // 「打开文件夹 = 开工作区 = 新窗口」（spec #194 决策 ②）；
      // 已在某窗口打开时 Rust 侧会聚焦那个窗口
      try {
        await openPathInNewWindow(path);
      } catch (err) {
        console.error("打开工作区失败:", err);
        const exists = await fileSystem.exists(path);
        if (!exists) {
          const folderName = basename(path);
          const shouldRemove = await dialog.confirm({
            message: t("common.dialog.folderNotFoundRemove", { name: folderName }),
            danger: true,
          });
          if (shouldRemove) {
            await persistence.removeRecent(path);
          }
        } else {
          dialog.alert({ message: t("common.error.openWorkspaceFailed", { error: err }), variant: "error" });
        }
      }
    } else {
      await openFile(path);
    }
  }

  return {
    openFile,
    openFileViaDialog,
    saveCurrentFile,
    saveAsCurrentFile,
    reloadCurrentFile,
    exportCurrentHtml,
    exportCurrentPdf,
    onNewTab,
    onNewFile,
    onOpenFolder,
    onOpenFile,
    onOpenRecent,
  };
}
