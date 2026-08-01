import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { basename } from "../utils/path";
import { exportHtml } from "./useHtmlExport";
import { fileSystem } from "../services/fileSystem";
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
    openFolderDialog: () => Promise<unknown>;
    openWorkspace: (path: string) => Promise<unknown>;
    hasWorkspace: boolean;
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
  const { tabsStore, workspace, persistence, dialog, toast, activeTab, currentTheme } = deps;
  const t = i18n.global.t.bind(i18n.global);

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
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] }],
      title: t("common.openMarkdownTitle"),
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
      filters: [{ name: "Markdown", extensions: ["md"] }],
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
    onNewTab();
  }

  function onOpenFolder(): void {
    void workspace.openFolderDialog();
  }

  function onOpenFile(): void {
    void openFileViaDialog();
  }

  async function onOpenRecent(path: string, type: "file" | "folder"): Promise<void> {
    if (type === "folder") {
      try {
        await workspace.openWorkspace(path);
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
