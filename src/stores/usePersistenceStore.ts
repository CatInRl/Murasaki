import { defineStore } from "pinia";
import { ref } from "vue";
import { LazyStore } from "@tauri-apps/plugin-store";
import {
  type SettingsState,
  type TabsState,
  type RecentEntry,
  type PersistedTab,
  DEFAULT_SETTINGS,
} from "../types";

/**
 * 持久化 Store
 * 使用 tauri-plugin-store 在 %APPDATA%\murasaki\ 下保存 JSON 文件：
 * - settings.json — 应用设置
 * - recent.json — 最近打开记录
 * - tabs.json — 标签页状态（用于启动恢复）
 *
 * 草稿文件单独由 Rust drafts 模块管理（drafts/<sha1>）。
 */
export const usePersistenceStore = defineStore("persistence", () => {
  // ===== State =====
  const settings = ref<SettingsState>({ ...DEFAULT_SETTINGS });
  const recentEntries = ref<RecentEntry[]>([]);
  const persistedTabs = ref<TabsState>({ tabs: [], activeIndex: 0 });
  /**
   * settings.json 的 `language` 字段是否从未被写入（首次启动，issue #141）。
   * 初始 false；loadSettings 时依据读到的 saved 判定：
   * saved 为空对象或 `saved.language === undefined` 视为从未写入 → true。
   * 仅供上层（App.vue 启动段）决定是否做系统语言探测，本 store 不改语言。
   */
  const languageEmpty = ref(false);

  // LazyStore 实例（懒加载，首次调用方法时初始化）
  let settingsStore: LazyStore | null = null;
  let recentStore: LazyStore | null = null;
  let tabsStore: LazyStore | null = null;

  function getSettingsStore(): LazyStore {
    if (!settingsStore) {
      settingsStore = new LazyStore("settings.json");
    }
    return settingsStore;
  }

  function getRecentStore(): LazyStore {
    if (!recentStore) {
      recentStore = new LazyStore("recent.json");
    }
    return recentStore;
  }

  function getTabsStore(): LazyStore {
    if (!tabsStore) {
      tabsStore = new LazyStore("tabs.json");
    }
    return tabsStore;
  }

  // ===== Settings =====
  async function loadSettings(): Promise<void> {
    try {
      const store = getSettingsStore();
      const saved = await store.get<SettingsState>("state");
      if (saved) {
        // 合并默认值，避免新版本增加字段时旧配置缺失
        settings.value = { ...DEFAULT_SETTINGS, ...saved };
      }
      // 判定 language 是否从未被写入（无 saved 或 saved 缺该字段视为从未写入）
      languageEmpty.value = !saved || saved.language === undefined;
    } catch (err) {
      console.warn("加载设置失败:", err);
    }
  }

  async function saveSettings(): Promise<void> {
    try {
      const store = getSettingsStore();
      await store.set("state", settings.value);
      await store.save();
    } catch (err) {
      console.error("保存设置失败:", err);
    }
  }

  async function updateSettings(patch: Partial<SettingsState>): Promise<void> {
    settings.value = { ...settings.value, ...patch };
    await saveSettings();
  }

  // ===== Recent =====
  async function loadRecent(): Promise<void> {
    try {
      const store = getRecentStore();
      const saved = await store.get<RecentEntry[]>("entries");
      if (Array.isArray(saved)) {
        recentEntries.value = saved;
      }
    } catch (err) {
      console.warn("加载最近打开失败:", err);
    }
  }

  async function addRecent(path: string, type: "file" | "folder"): Promise<void> {
    const filtered = recentEntries.value.filter((e) => e.path !== path);
    filtered.unshift({
      path,
      type,
      openedAt: Date.now(),
    });
    // 限制 20 条
    recentEntries.value = filtered.slice(0, 20);
    await saveRecent();
  }

  async function removeRecent(path: string): Promise<void> {
    recentEntries.value = recentEntries.value.filter((e) => e.path !== path);
    await saveRecent();
  }

  async function saveRecent(): Promise<void> {
    try {
      const store = getRecentStore();
      await store.set("entries", recentEntries.value);
      await store.save();
    } catch (err) {
      console.error("保存最近打开失败:", err);
    }
  }

  /** 获取最近打开的文件夹列表（最多 5 条） */
  function getRecentFolders(limit = 5): RecentEntry[] {
    return recentEntries.value
      .filter((e) => e.type === "folder")
      .slice(0, limit);
  }

  /** 获取最近打开的文件列表（最多 5 条） */
  function getRecentFiles(limit = 5): RecentEntry[] {
    return recentEntries.value
      .filter((e) => e.type === "file")
      .slice(0, limit);
  }

  // ===== Tabs =====
  async function loadTabs(): Promise<TabsState> {
    try {
      const store = getTabsStore();
      const saved = await store.get<TabsState>("state");
      if (saved && Array.isArray(saved.tabs)) {
        persistedTabs.value = saved;
        return saved;
      }
    } catch (err) {
      console.warn("加载标签页状态失败:", err);
    }
    return { tabs: [], activeIndex: 0 };
  }

  async function saveTabs(tabs: PersistedTab[], activeIndex: number): Promise<void> {
    persistedTabs.value = { tabs, activeIndex };
    try {
      const store = getTabsStore();
      await store.set("state", persistedTabs.value);
      await store.save();
    } catch (err) {
      console.error("保存标签页状态失败:", err);
    }
  }

  async function clearTabs(): Promise<void> {
    persistedTabs.value = { tabs: [], activeIndex: 0 };
    try {
      const store = getTabsStore();
      await store.set("state", persistedTabs.value);
      await store.save();
    } catch (err) {
      console.error("清除标签页状态失败:", err);
    }
  }

  return {
    // state
    settings,
    recentEntries,
    persistedTabs,
    languageEmpty,
    // settings actions
    loadSettings,
    saveSettings,
    updateSettings,
    // recent actions
    loadRecent,
    addRecent,
    removeRecent,
    getRecentFolders,
    getRecentFiles,
    // tabs actions
    loadTabs,
    saveTabs,
    clearTabs,
  };
});
