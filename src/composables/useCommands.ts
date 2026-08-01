import type { Ref } from "vue";
import type { EditorView } from "@codemirror/view";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  setHeading,
  toggleList,
  toggleCodeBlock,
  toggleBlockquote,
  insertHorizontalRule,
} from "./useEditorCommands";
import type { AlertVariant } from "../stores/useDialogStore";
import type { SidebarView } from "../types";
import type { UpdateInfo } from "./useUpdater";

// ===== 编辑器实例最小切片 =====

interface EditorPaneLike {
  getView: () => EditorView | null;
}

// ===== 依赖类型切片 =====

export interface CommandsDeps {
  // 文件操作（来自 useFileActions）
  onNewTab: () => void;
  openFileViaDialog: () => Promise<void>;
  saveCurrentFile: () => Promise<void>;
  saveAsCurrentFile: () => Promise<void>;
  reloadCurrentFile: () => Promise<void>;
  exportCurrentHtml: () => Promise<void>;
  exportCurrentPdf: () => Promise<void>;
  copyRichText: () => Promise<void>;

  // Tab 关闭（来自 useTabClose）
  onCloseTabRequest: (tabId: string) => Promise<void>;

  // workspace store 切片
  workspace: {
    openFolderDialog: () => Promise<unknown>;
    closeWorkspace: () => void;
    hasWorkspace: boolean;
    workspacePath: string | null;
  };

  // tabs store 切片
  tabsStore: {
    activeTabId: string | null;
    switchNext: () => void;
    switchPrev: () => void;
  };

  // search store 切片
  searchStore: {
    visible: boolean;
  };

  // file ops store 切片
  fileOps: {
    createDirectory: (parent: string, name: string) => Promise<unknown>;
  };

  // dialog store 切片
  dialog: {
    alert: (options: {
      message: string;
      variant?: AlertVariant;
      title?: string;
    }) => Promise<void>;
    prompt: (options: {
      message?: string;
      placeholder?: string;
    }) => Promise<string | null>;
  };

  // 响应式状态（commands 读写）
  editorRef: Ref<EditorPaneLike | null>;
  currentTheme: Ref<string>;
  sidebarView: Ref<SidebarView>;
  statusBarVisible: Ref<boolean>;
  tableDialogVisible: Ref<boolean>;

  // updater 切片（T1.1：检查更新）
  updater: {
    check(silent?: boolean): Promise<UpdateInfo | null>;
  };

  // 其他函数
  openSettings: () => Promise<void>;
  toggleFullscreen: () => Promise<void>;
}

/**
 * 命令分发：菜单事件 + 全局快捷键。
 *
 * 从 App.vue 提取 handleMenuEvent + onKeyDown，保持原有行为不变。
 * 依赖通过 CommandsDeps 注入，便于后续测试与维护。
 */
export function useCommands(deps: CommandsDeps) {
  const {
    onNewTab, openFileViaDialog, saveCurrentFile, saveAsCurrentFile,
    reloadCurrentFile, exportCurrentHtml, exportCurrentPdf, copyRichText,
    onCloseTabRequest,
    workspace, tabsStore, searchStore, fileOps, dialog,
    editorRef, currentTheme, sidebarView, statusBarVisible,
    tableDialogVisible,
    openSettings, toggleFullscreen, updater,
  } = deps;

  /** 由原生菜单触发的命令分发 */
  async function handleMenuEvent(menuId: string): Promise<void> {
    switch (menuId) {
      case "new-file":
        onNewTab();
        break;
      case "open-file":
        await openFileViaDialog();
        break;
      case "open-folder":
        await workspace.openFolderDialog();
        break;
      case "close-workspace":
        workspace.closeWorkspace();
        break;
      case "save":
        await saveCurrentFile();
        break;
      case "save-as":
        await saveAsCurrentFile();
        break;
      case "close-tab":
        if (tabsStore.activeTabId) {
          await onCloseTabRequest(tabsStore.activeTabId);
        }
        break;
      case "reload-file":
        await reloadCurrentFile();
        break;
      case "export-html":
        await exportCurrentHtml();
        break;
      case "export-pdf":
        await exportCurrentPdf();
        break;
      case "copy-rich-text":
        await copyRichText();
        break;
      case "find-in-files":
        searchStore.visible = true;
        break;
      case "settings":
        await openSettings();
        break;
      case "theme-murasaki":
        currentTheme.value = "murasaki";
        break;
      case "theme-github":
        currentTheme.value = "github";
        break;
      case "theme-newsprint":
        currentTheme.value = "newsprint";
        break;
      case "theme-night":
        currentTheme.value = "night";
        break;
      case "theme-academic":
        currentTheme.value = "academic";
        break;
      // 段落菜单：调用编辑器命令
      case "heading-1":
      case "heading-2":
      case "heading-3":
      case "heading-4":
      case "heading-5":
      case "heading-6":
      case "normal": {
        const view = editorRef.value?.getView();
        if (view) {
          const level = menuId === "normal" ? 0 : parseInt(menuId.split("-")[1], 10);
          setHeading(view, level);
        }
        break;
      }
      case "code-block": {
        const view = editorRef.value?.getView();
        if (view) toggleCodeBlock(view);
        break;
      }
      case "blockquote": {
        const view = editorRef.value?.getView();
        if (view) toggleBlockquote(view);
        break;
      }
      case "unordered-list": {
        const view = editorRef.value?.getView();
        if (view) toggleList(view, "unordered");
        break;
      }
      case "ordered-list": {
        const view = editorRef.value?.getView();
        if (view) toggleList(view, "ordered");
        break;
      }
      case "task-list": {
        const view = editorRef.value?.getView();
        if (view) toggleList(view, "task");
        break;
      }
      case "horizontal-rule": {
        const view = editorRef.value?.getView();
        if (view) insertHorizontalRule(view);
        break;
      }
      case "insert-table": {
        // 打开插入表格对话框
        tableDialogVisible.value = true;
        break;
      }
      case "new-folder": {
        // 在工作区根目录新建文件夹
        if (!workspace.hasWorkspace) {
          dialog.alert({ message: "请先打开一个工作区", variant: "warning" });
          break;
        }
        const name = await dialog.prompt({ message: "请输入文件夹名称：", placeholder: "文件夹名称" });
        if (name && name.trim()) {
          try {
            await fileOps.createDirectory(workspace.workspacePath!, name.trim());
          } catch (err) {
            dialog.alert({ message: `新建文件夹失败: ${err}`, variant: "error" });
          }
        }
        break;
      }
      case "find":
      case "replace": {
        // 调用 CodeMirror 的搜索面板
        const view = editorRef.value?.getView();
        if (view) {
          const { openSearchPanel } = await import("@codemirror/search");
          openSearchPanel(view);
        }
        break;
      }
      case "quit": {
        try {
          await getCurrentWebviewWindow().close();
        } catch (err) {
          console.error("退出失败:", err);
        }
        break;
      }
      case "docs": {
        try {
          const { open } = await import("@tauri-apps/plugin-shell");
          await open("https://github.com/CatInRl/Murasaki");
        } catch {
          dialog.alert({ message: "文档暂未在线发布" });
        }
        break;
      }
      case "about": {
        dialog.alert({ title: "关于 Murasaki", message: "Murasaki v0.3.0\n轻量级本地 Markdown 文件管理编辑器\n基于 Tauri 2.x + Vue 3 + CodeMirror 6" });
        break;
      }
      case "check-updates": {
        // T1.1（ADR-0012）：菜单触发检查更新（非静默，会弹 UpdateDialog 或 toast）
        await updater.check(false);
        break;
      }
      default:
        break;
    }
  }

  /** 全局快捷键处理 */
  function onKeyDown(e: KeyboardEvent): void {
    const ctrl = e.ctrlKey || e.metaKey;
    // Ctrl+W：关闭当前 tab
    if (ctrl && e.key === "w" && !e.shiftKey) {
      e.preventDefault();
      if (tabsStore.activeTabId) {
        void onCloseTabRequest(tabsStore.activeTabId);
      }
      return;
    }
    // Ctrl+Tab：切换到下一个 tab
    if (ctrl && e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      tabsStore.switchNext();
      return;
    }
    // Ctrl+Shift+Tab：切换到上一个 tab
    if (ctrl && e.shiftKey && e.key === "Tab") {
      e.preventDefault();
      tabsStore.switchPrev();
      return;
    }
    // Ctrl+S：保存
    if (ctrl && e.key === "s" && !e.shiftKey) {
      e.preventDefault();
      void saveCurrentFile();
      return;
    }
    // Ctrl+Shift+E：切换到文件树（无工作区时切换到大纲）
    if (ctrl && e.shiftKey && (e.key === "E" || e.key === "e")) {
      e.preventDefault();
      sidebarView.value = workspace.hasWorkspace ? "files" : "outline";
      return;
    }
    // Ctrl+Shift+M：切换到大纲
    if (ctrl && e.shiftKey && (e.key === "M" || e.key === "m")) {
      e.preventDefault();
      sidebarView.value = "outline";
      return;
    }
    // Ctrl+Shift+F：在文件中查找（打开搜索面板）
    if (ctrl && e.shiftKey && (e.key === "F" || e.key === "f")) {
      e.preventDefault();
      searchStore.visible = true;
      return;
    }
    // Ctrl+R：重新加载当前文件
    if (ctrl && !e.shiftKey && (e.key === "r" || e.key === "R")) {
      e.preventDefault();
      void reloadCurrentFile();
      return;
    }
    // F11：切换全屏
    if (e.key === "F11") {
      e.preventDefault();
      void toggleFullscreen();
      return;
    }
    // Alt+Shift+S：切换状态栏显隐
    if (e.altKey && e.shiftKey && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      statusBarVisible.value = !statusBarVisible.value;
      return;
    }
  }

  return { handleMenuEvent, onKeyDown };
}
