/**
 * 「全部标签」面板的列表派生与过滤（issue #168 / #279）
 *
 * 纯逻辑，便于单测；面板渲染与键盘交互在 TabBar.vue。
 *
 * 设计边界（见 CONTEXT.md「全部标签面板」）：
 * - **定位器，不是搜索器**：只按标题与所在目录过滤，不碰文件内容；
 * - **顺序 = 标签栏顺序**：不按最近使用排序；
 * - **窗口内**：只处理本窗口传进来的 tabs（标签状态本就按窗口隔离）。
 */
import { dirname, isTabOutOfWorkspace } from "./path";
import type { Tab } from "../types";

export interface TabListEntry {
  id: string;
  /** 显示标题（未命名标签的文案由调用方注入，避免本模块依赖 i18n） */
  title: string;
  /** 所在目录；未命名标签（无路径）为 null */
  subtitle: string | null;
  isActive: boolean;
  isDirty: boolean;
  isOutOfWorkspace: boolean;
}

export interface BuildTabListOptions {
  activeTabId: string | null;
  workspacePath: string | null;
  /** 标题解析：复用 tabs store 的 getTabTitle（含未命名文案），避免标题语义分叉 */
  titleOf: (tab: Tab) => string;
}

/** 按标签栏顺序派生面板条目 */
export function buildTabList(tabs: Tab[], opts: BuildTabListOptions): TabListEntry[] {
  return tabs.map((tab) => ({
    id: tab.id,
    title: opts.titleOf(tab),
    subtitle: tab.path ? dirname(tab.path) : null,
    isActive: tab.id === opts.activeTabId,
    isDirty: tab.isDirty,
    // 与 TabBar 的角标判定同源（未命名标签与无工作区都不算「工作区外」）
    isOutOfWorkspace: isTabOutOfWorkspace(opts.workspacePath, tab.path),
  }));
}

/** 按「标题 + 所在目录」过滤（大小写不敏感）；空查询返回原列表 */
export function filterTabList(entries: TabListEntry[], query: string): TabListEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) =>
    `${e.title} ${e.subtitle ?? ""}`.toLowerCase().includes(q)
  );
}
