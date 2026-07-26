import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { Tab, PersistedTab } from "../types";
import { usePersistenceStore } from "./usePersistenceStore";
import { basename } from "../utils/path";

/**
 * 标签页 Store
 * - 管理多 Tab 的打开/关闭/切换
 * - 草稿恢复：关闭有未保存修改的 tab 时写入草稿
 * - 启动恢复：从 tabs.json 读取上次状态，结合草稿恢复内容
 */
export const useTabsStore = defineStore("tabs", () => {
  // ===== State =====
  /** 标签页列表 */
  const tabs = ref<Tab[]>([]);
  /** 当前激活的 tab id */
  const activeTabId = ref<string | null>(null);
  /** 加载中标志（启动恢复时） */
  const restoring = ref(false);

  // ===== Getters =====
  /** 当前激活的 tab 索引 */
  const activeIndex = computed(() => {
    if (!activeTabId.value) return -1;
    return tabs.value.findIndex((t) => t.id === activeTabId.value);
  });

  /** 当前激活的 tab */
  const activeTab = computed<Tab | null>(() => {
    const idx = activeIndex.value;
    return idx >= 0 ? tabs.value[idx] : null;
  });

  /** 是否有打开的标签页 */
  const hasTabs = computed(() => tabs.value.length > 0);

  /** 生成唯一 tab id */
  function genId(): string {
    return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** 获取 tab 显示标题（仅文件名） */
  function getTabTitle(tab: Tab): string {
    return tab.path ? basename(tab.path) : "未命名";
  }

  // ===== Actions =====
  /**
   * 打开文件为标签页
   * - 若该路径已在某个 tab 中，则激活该 tab
   * - 否则创建新 tab
   *
   * 草稿恢复与 mtime 冲突检测（ADR 0001）：
   *   - 若有草稿且草稿的 knownMtime == 文件当前 mtime → 用草稿内容（用户上次未保存）
   *   - 若有草稿但 knownMtime != 文件当前 mtime → 磁盘在外部被改过，丢弃草稿，使用磁盘内容
   *     （草稿已过期，强行使用会让用户失去外部更新的内容）
   */
  async function openFile(path: string): Promise<Tab> {
    // 检查是否已打开
    const existing = tabs.value.find((t) => t.path === path);
    if (existing) {
      activeTabId.value = existing.id;
      return existing;
    }

    try {
      const content = await invoke<string>("read_text_file", { path });
      const mtime = await invoke<number>("get_file_mtime", { path }).catch(() => 0);

      // 检查是否有草稿（上次未保存的内容）
      let finalContent = content;
      let isDirty = false;
      const hasDraft = await invoke<boolean>("draft_exists", { path }).catch(() => false);
      if (hasDraft) {
        // 读取草稿与保存时的 knownMtime
        const [draftContent, knownMtime] = await invoke<[string, number]>("read_draft", { path });
        // 仅当草稿基于的 mtime 与当前文件 mtime 一致时才采用草稿内容
        // 否则磁盘已被外部修改，草稿过期，回退到磁盘内容
        if (knownMtime === mtime) {
          finalContent = draftContent;
          isDirty = true;
        } else {
          // 草稿过期，清理掉
          await invoke("delete_draft", { path }).catch(() => {});
        }
      }

      const tab: Tab = {
        id: genId(),
        path,
        content: finalContent,
        lastMtime: mtime,
        isDirty,
        hasExternalChange: false,
        cursor: { line: 1, ch: 0 },
        scroll: { x: 0, y: 0 },
      };
      tabs.value.push(tab);
      activeTabId.value = tab.id;
      return tab;
    } catch (err) {
      console.error("打开文件失败:", err);
      throw err;
    }
  }

  /**
   * 创建新标签页（未关联文件）
   */
  function newTab(initialContent = ""): Tab {
    const tab: Tab = {
      id: genId(),
      path: null,
      content: initialContent,
      lastMtime: null,
      isDirty: initialContent.length > 0,
      hasExternalChange: false,
      cursor: { line: 1, ch: 0 },
      scroll: { x: 0, y: 0 },
    };
    tabs.value.push(tab);
    activeTabId.value = tab.id;
    return tab;
  }

  /**
   * 关闭标签页
   * - 若有未保存修改，由调用方决定如何处理（保存/不保存/取消）
   *   - 选择"保存"：调用方先调 saveTab / saveTabAs，再调本方法
   *   - 选择"不保存"：直接调本方法，会自动写草稿保留未保存内容
   *   - 选择"取消"：调用方不调本方法
   * - 本方法只负责写草稿 + 从列表中移除 + 调整激活 tab
   */
  async function closeTab(tabId: string): Promise<{ needsConfirm: boolean; tab: Tab | null }> {
    const idx = tabs.value.findIndex((t) => t.id === tabId);
    if (idx < 0) return { needsConfirm: false, tab: null };

    const tab = tabs.value[idx];
    // 通知调用方：此 tab 需要弹出"保存/不保存/取消"对话框
    // 调用方应处理完用户选择后再调用本方法执行真正的关闭
    if (tab.isDirty) {
      return { needsConfirm: true, tab };
    }

    // 无未保存修改：直接关闭
    return doCloseTab(tabId);
  }

  /**
   * 真正执行关闭动作（写草稿 + 移除 + 调整激活）
   * 调用方处理完未保存确认后调用本方法
   */
  async function doCloseTab(tabId: string): Promise<{ needsConfirm: boolean; tab: Tab | null }> {
    const idx = tabs.value.findIndex((t) => t.id === tabId);
    if (idx < 0) return { needsConfirm: false, tab: null };

    const tab = tabs.value[idx];
    if (tab.isDirty && tab.path) {
      // 写入草稿（保留未保存内容，供下次启动恢复）
      await invoke("save_draft", {
        path: tab.path,
        content: tab.content,
        knownMtime: tab.lastMtime ?? 0,
      }).catch((err) => console.error("保存草稿失败:", err));
    }

    tabs.value.splice(idx, 1);

    // 调整激活的 tab
    if (activeTabId.value === tabId) {
      if (tabs.value.length === 0) {
        activeTabId.value = null;
      } else {
        // 激活相邻 tab（优先前一个）
        const newIdx = Math.min(idx, tabs.value.length - 1);
        activeTabId.value = tabs.value[newIdx].id;
      }
    }

    return { needsConfirm: false, tab };
  }

  /** 按路径查找 tab（消除 App.vue 中的 message chain） */
  function getTabByPath(filePath: string): Tab | null {
    return tabs.value.find((t) => t.path === filePath) ?? null;
  }

  /**
   * 应用外部修改处理结果到 tab
   * - "load-disk"：用磁盘内容覆盖 tab 内容，更新 mtime，清除 dirty 与外部修改标记
   * - "keep-local"：用户选择保留本地版本，将 lastMtime 对齐到磁盘当前 mtime，
   *   否则关闭时写入草稿的 knownMtime 与磁盘不一致，下次打开会被判定为过期草稿而丢弃
   */
  async function applyExternalResolution(
    filePath: string,
    choice: "load-disk" | "keep-local",
    externalContent?: string
  ): Promise<void> {
    const tab = getTabByPath(filePath);
    if (!tab) return;
    if (choice === "load-disk") {
      if (externalContent !== undefined) {
        tab.content = externalContent;
      }
      const mtime = await invoke<number>("get_file_mtime", { path: filePath }).catch(() => 0);
      tab.lastMtime = mtime;
      tab.isDirty = false;
      tab.hasExternalChange = false;
    } else {
      // keep-local：将 lastMtime 对齐磁盘当前 mtime，保证草稿 knownMtime 与磁盘一致
      // 这样关闭未保存时草稿能被下次启动正确恢复
      const mtime = await invoke<number>("get_file_mtime", { path: filePath }).catch(() => 0);
      tab.lastMtime = mtime;
      tab.isDirty = true;
      tab.hasExternalChange = true;
    }
  }

  /**
   * 标记 tab 的外部修改状态（用于文件被外部删除等场景）
   */
  function markExternalChange(filePath: string, changed: boolean): void {
    const tab = getTabByPath(filePath);
    if (tab) tab.hasExternalChange = changed;
  }

  /**
   * 从磁盘重新加载 tab 内容（覆盖本地修改，外部修改未弹窗时使用）
   */
  async function reloadFromDisk(filePath: string): Promise<void> {
    const tab = getTabByPath(filePath);
    if (!tab) return;
    const content = await invoke<string>("read_text_file", { path: filePath });
    const mtime = await invoke<number>("get_file_mtime", { path: filePath }).catch(() => 0);
    tab.content = content;
    tab.lastMtime = mtime;
    tab.isDirty = false;
    tab.hasExternalChange = false;
  }

  /**
   * 写入合并后的内容到磁盘并更新 tab（对比窗口保存时调用）
   */
  async function writeMergedContent(filePath: string, mergedContent: string): Promise<void> {
    await invoke("write_text_file", { path: filePath, content: mergedContent });
    const mtime = await invoke<number>("get_file_mtime", { path: filePath }).catch(() => 0);
    const tab = getTabByPath(filePath);
    if (tab) {
      tab.content = mergedContent;
      tab.lastMtime = mtime;
      tab.isDirty = false;
      tab.hasExternalChange = false;
    }
  }

  /**
   * 关闭当前激活的 tab
   */
  async function closeActive(): Promise<void> {
    if (activeTabId.value) {
      await closeTab(activeTabId.value);
    }
  }

  /**
   * 切换激活的 tab
   */
  function switchTo(tabId: string): void {
    if (tabs.value.some((t) => t.id === tabId)) {
      activeTabId.value = tabId;
    }
  }

  /**
   * 切换到下一个 tab（Ctrl+Tab）
   */
  function switchNext(): void {
    if (tabs.value.length === 0) return;
    const idx = activeIndex.value;
    const nextIdx = (idx + 1) % tabs.value.length;
    activeTabId.value = tabs.value[nextIdx].id;
  }

  /**
   * 切换到上一个 tab（Ctrl+Shift+Tab）
   */
  function switchPrev(): void {
    if (tabs.value.length === 0) return;
    const idx = activeIndex.value;
    const prevIdx = (idx - 1 + tabs.value.length) % tabs.value.length;
    activeTabId.value = tabs.value[prevIdx].id;
  }

  /**
   * 更新 tab 内容（编辑器输入时调用）
   */
  function updateContent(tabId: string, content: string): void {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (tab) {
      tab.content = content;
      tab.isDirty = true;
    }
  }

  /**
   * 更新当前激活 tab 的内容
   */
  function updateActiveContent(content: string): void {
    if (activeTabId.value) {
      updateContent(activeTabId.value, content);
    }
  }

  /**
   * 保存 tab 到磁盘文件
   */
  async function saveTab(tabId: string): Promise<void> {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (!tab || !tab.path) {
      throw new Error("无文件路径，请使用另存为");
    }
    await invoke("write_text_file", { path: tab.path, content: tab.content });
    // 更新 mtime
    const mtime = await invoke<number>("get_file_mtime", { path: tab.path }).catch(() => 0);
    tab.lastMtime = mtime;
    tab.isDirty = false;
    tab.hasExternalChange = false;
    // 删除草稿（已保存到磁盘）
    await invoke("delete_draft", { path: tab.path }).catch(() => {});
  }

  /**
   * 另存为：将 tab 内容保存到新路径，并更新 tab.path
   */
  async function saveTabAs(tabId: string, newPath: string): Promise<void> {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (!tab) return;
    await invoke("write_text_file", { path: newPath, content: tab.content });
    const mtime = await invoke<number>("get_file_mtime", { path: newPath }).catch(() => 0);
    tab.path = newPath;
    tab.lastMtime = mtime;
    tab.isDirty = false;
    tab.hasExternalChange = false;
  }

  /**
   * 关闭所有 tab（应用退出时调用）
   * 为有未保存修改的 tab 写入草稿
   */
  async function closeAll(): Promise<void> {
    for (const tab of tabs.value) {
      if (tab.isDirty && tab.path) {
        await invoke("save_draft", {
          path: tab.path,
          content: tab.content,
          knownMtime: tab.lastMtime ?? 0,
        }).catch((err) => console.error("保存草稿失败:", err));
      }
    }
  }

  /**
   * 持久化当前 tabs 状态（用于启动恢复）
   */
  async function persist(): Promise<void> {
    const persistence = usePersistenceStore();
    const toSave: PersistedTab[] = tabs.value.map((t) => ({
      path: t.path,
      content: t.content,
      lastMtime: t.lastMtime,
      cursor: t.cursor,
      scroll: t.scroll,
    }));
    await persistence.saveTabs(toSave, Math.max(0, activeIndex.value));
  }

  /**
   * 从持久化状态恢复 tabs（应用启动时调用）
   * 注意：草稿内容已在 openFile 中读取，这里仅恢复路径列表
   */
  async function restore(): Promise<void> {
    restoring.value = true;
    try {
      const persistence = usePersistenceStore();
      const state = await persistence.loadTabs();
      if (state.tabs.length === 0) return;

      // 恢复每个 tab
      for (const persisted of state.tabs) {
        if (persisted.path) {
          try {
            await openFile(persisted.path);
            // 覆盖光标/滚动位置（openFile 不恢复这些）
            const tab = tabs.value.find((t) => t.path === persisted.path);
            if (tab) {
              tab.cursor = persisted.cursor;
              tab.scroll = persisted.scroll;
            }
          } catch (err) {
            console.warn(`恢复 tab 失败: ${persisted.path}`, err);
          }
        } else {
          // 未保存的新文件 tab
          newTab(persisted.content);
        }
      }

      // 恢复激活索引
      if (state.activeIndex >= 0 && state.activeIndex < tabs.value.length) {
        activeTabId.value = tabs.value[state.activeIndex].id;
      }
    } finally {
      restoring.value = false;
    }
  }

  /**
   * 清除所有 tabs（不写草稿，用于"关闭工作区"等场景）
   */
  function clearAll(): void {
    tabs.value = [];
    activeTabId.value = null;
  }

  return {
    // state
    tabs,
    activeTabId,
    restoring,
    // getters
    activeIndex,
    activeTab,
    hasTabs,
    // actions
    openFile,
    newTab,
    closeTab,
    doCloseTab,
    closeActive,
    switchTo,
    switchNext,
    switchPrev,
    updateContent,
    updateActiveContent,
    saveTab,
    saveTabAs,
    closeAll,
    persist,
    restore,
    clearAll,
    // 外部修改相关
    getTabByPath,
    applyExternalResolution,
    markExternalChange,
    reloadFromDisk,
    writeMergedContent,
    // helpers
    getTabTitle,
  };
});
