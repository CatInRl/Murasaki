/**
 * 统一全局搜索条 —— 匹配与分组纯函数
 *
 * - matchText：前端模糊匹配（文件名 / 标签 / 最近），字符跳序 + 大小写不敏感 + 多词 AND。
 *   内容命中由 Rust `search_workspace` 负责（支持正则 / 大小写 / 全词），不经过本函数过滤；
 *   本函数仅为其 snippet 提供最佳努力的高亮 ranges。
 * - buildGroups：按「打开的标签 > 最近文件 > 文件名 > 内容命中」分组，实现数量上限、
 *   去重（标签 > 最近 > 文件名 > 内容）、前缀优先排序、无工作区降级与空查询默认态。
 *
 * 两者均为纯函数，便于单元测试（议题簇 1 / 4）。
 */
import { dirname } from "../utils/path";

// ===== 匹配 =====

export interface TextMatchResult {
  /** 是否命中（所有词均按序出现） */
  ok: boolean;
  /** 命中段（text 内的 [start, end)），每个匹配词一段；未命中或空查询为空数组 */
  ranges: [number, number][];
}

/**
 * 前端模糊匹配：query 按空白拆词，每词字符在 text 中按序出现（大小写不敏感）即命中。
 * 返回每个词的连续命中段（首字符 → 末字符），供 UI 高亮。
 */
export function matchText(text: string, query: string): TextMatchResult {
  const trimmed = query.trim();
  if (!trimmed) return { ok: true, ranges: [] };
  const lowerText = text.toLowerCase();
  const words = trimmed.split(/\s+/).filter(Boolean);
  const ranges: [number, number][] = [];
  for (const word of words) {
    const span = matchWordSpan(lowerText, word.toLowerCase());
    if (!span) return { ok: false, ranges: [] };
    ranges.push(span);
  }
  return { ok: true, ranges };
}

/** 单个词在文本中按序出现的最小连续段 [start, end)；任一字缺失返回 null */
function matchWordSpan(lowerText: string, lowerWord: string): [number, number] | null {
  let pos = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < lowerWord.length; i++) {
    const idx = lowerText.indexOf(lowerWord[i], pos);
    if (idx === -1) return null;
    if (first === -1) first = idx;
    last = idx + 1;
    pos = idx + 1;
  }
  return [first, last];
}

// ===== 分组 =====

/** 结果分组类型（展示顺序固定：tabs > recent > files > content） */
export type SearchGroupKind = "tabs" | "recent" | "files" | "content";

/** 结果条目（GlobalSearchBar 渲染 + 键盘导航所需的最小信息） */
export interface SearchEntry {
  /** 稳定 id（键盘导航 / 滚动定位用） */
  id: string;
  /** 所属分组 */
  group: SearchGroupKind;
  /** 展示标题（basename / 标签标题） */
  title: string;
  /** 文件路径；未保存标签为 null */
  path: string | null;
  /** 副标题（目录 / 相对路径；内容命中为空串） */
  subtitle: string;
  /** 标题内匹配高亮段 */
  ranges: [number, number][];
  /** 是否已作为标签打开（显示「已打开」chip；回车切换标签而非 openFile） */
  isOpen: boolean;
  /** 已打开标签的 tabId（tabs 组） */
  tabId?: string;
  /** 内容命中行号（content 组） */
  lineNumber?: number;
  /** 内容命中行片段（content 组） */
  snippet?: string;
  /** 片段内匹配高亮段（content 组，最佳努力） */
  snippetRanges?: [number, number][];
}

/** 结果分组（kind → i18n 文案由组件映射） */
export interface SearchGroup {
  kind: SearchGroupKind;
  items: SearchEntry[];
}

/** 数据源类型（store 层注入） */
export interface SearchTabSource {
  id: string;
  path: string | null;
  title: string;
}

export interface SearchRecentSource {
  path: string;
  title: string;
}

export interface SearchFileSource {
  path: string;
  title: string;
  /** 相对工作区目录（副标题展示用）；缺省回退 dirname(path) */
  relativeDir?: string;
}

export interface SearchContentHit {
  lineNumber: number;
  snippet: string;
}

export interface SearchContentFileSource {
  path: string;
  title: string;
  /** 命中行（行号升序，store 层保证） */
  hits: SearchContentHit[];
}

export interface BuildGroupsContext {
  /** 当前查询串（原始输入） */
  query: string;
  /** 是否已打开工作区（false → 降级为仅标签 + 最近） */
  hasWorkspace: boolean;
  /** 打开的标签（打开顺序） */
  tabs: SearchTabSource[];
  /** 最近文件（最近时间倒序） */
  recents: SearchRecentSource[];
  /** 工作区文件名（遍历文件树得到） */
  files: SearchFileSource[];
  /** 内容命中（Rust search_workspace 结果，已按文件聚合、行号升序） */
  content: SearchContentFileSource[];
}

/** 各分组数量上限（W2 决策） */
export const SEARCH_LIMITS = {
  tabs: 5,
  recent: 5,
  files: 8,
  contentFiles: 5,
  contentPerFile: 2,
} as const;

/**
 * 构建结果分组。
 * - 空查询：仅「打开的标签 + 最近文件」。
 * - 无工作区：降级为仅「打开的标签 + 最近文件」（仍可搜索切换 / 打开）。
 * - 去重：同一路径不跨组重复（优先级 标签 > 最近 > 文件名 > 内容）。
 * - 排序：文件名组 前缀命中优先 → 名称长度升序；其余按数据源顺序。
 */
export function buildGroups(ctx: BuildGroupsContext): SearchGroup[] {
  const query = ctx.query.trim();
  const empty = query.length === 0;
  const groups: SearchGroup[] = [];
  const shown = new Set<string>();
  let seq = 0;
  const nextId = (kind: SearchGroupKind) => `${kind}-${seq++}`;

  // —— 打开的标签（≤5；空查询 / 无工作区均展示）——
  const tabItems: SearchEntry[] = [];
  for (const t of ctx.tabs) {
    if (tabItems.length >= SEARCH_LIMITS.tabs) break;
    if (!empty && !entryMatches(t.title, t.path, query)) continue;
    const key = t.path ?? `__unsaved:${t.id}`;
    shown.add(key);
    tabItems.push({
      id: nextId("tabs"),
      group: "tabs",
      title: t.title,
      path: t.path,
      subtitle: t.path ? dirname(t.path) : "",
      ranges: empty ? [] : matchText(t.title, query).ranges,
      isOpen: true,
      tabId: t.id,
    });
  }
  if (tabItems.length) groups.push({ kind: "tabs", items: tabItems });

  // —— 最近文件（≤5；排除已在标签中的路径；空查询 / 无工作区均展示）——
  const recentItems: SearchEntry[] = [];
  for (const r of ctx.recents) {
    if (recentItems.length >= SEARCH_LIMITS.recent) break;
    if (shown.has(r.path)) continue;
    if (!empty && !entryMatches(r.title, r.path, query)) continue;
    shown.add(r.path);
    recentItems.push({
      id: nextId("recent"),
      group: "recent",
      title: r.title,
      path: r.path,
      subtitle: dirname(r.path),
      ranges: empty ? [] : matchText(r.title, query).ranges,
      isOpen: false,
    });
  }
  if (recentItems.length) groups.push({ kind: "recent", items: recentItems });

  // 无工作区或空查询（默认态）：不再展示文件名 / 内容命中（降级）
  if (!ctx.hasWorkspace || empty) return groups;

  // —— 文件名（≤8；前缀命中优先 → 名称长度升序；排除已显示路径）——
  if (ctx.files.length) {
    const firstKw = empty ? "" : query.split(/\s+/)[0].toLowerCase();
    const matched = ctx.files
      .filter((f) => !shown.has(f.path))
      .filter((f) => empty || entryMatches(f.title, f.path, query))
      .sort((a, b) => {
        const ap = firstKw && a.title.toLowerCase().startsWith(firstKw) ? 0 : 1;
        const bp = firstKw && b.title.toLowerCase().startsWith(firstKw) ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return a.title.length - b.title.length;
      })
      .slice(0, SEARCH_LIMITS.files);
    const fileItems: SearchEntry[] = matched.map((f) => {
      shown.add(f.path);
      return {
        id: nextId("files"),
        group: "files",
        title: f.title,
        path: f.path,
        subtitle: f.relativeDir ?? dirname(f.path),
        ranges: empty ? [] : matchText(f.title, query).ranges,
        isOpen: false,
      };
    });
    if (fileItems.length) groups.push({ kind: "files", items: fileItems });
  }

  // —— 内容命中（仅 .md；≤5 文件 × 每文件 ≤2 条；行号升序；排除已显示路径）——
  if (!empty && ctx.content.length) {
    const contentItems: SearchEntry[] = [];
    let filesUsed = 0;
    for (const c of ctx.content) {
      if (filesUsed >= SEARCH_LIMITS.contentFiles) break;
      if (shown.has(c.path)) continue;
      const hits = c.hits.slice(0, SEARCH_LIMITS.contentPerFile);
      if (!hits.length) continue;
      shown.add(c.path);
      filesUsed++;
      for (const h of hits) {
        contentItems.push({
          id: nextId("content"),
          group: "content",
          title: c.title,
          path: c.path,
          subtitle: "",
          ranges: matchText(c.title, query).ranges,
          isOpen: false,
          lineNumber: h.lineNumber,
          snippet: h.snippet,
          snippetRanges: matchText(h.snippet, query).ranges,
        });
      }
    }
    if (contentItems.length) groups.push({ kind: "content", items: contentItems });
  }

  return groups;
}

/** 标题 + 路径合并后做前端模糊匹配（未保存标签仅匹配标题） */
function entryMatches(title: string, path: string | null, query: string): boolean {
  const hay = path ? `${title} ${path}` : title;
  return matchText(hay, query).ok;
}
