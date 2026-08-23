<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { useI18n } from "vue-i18n";
import {
  Code2,
  FileText,
  Files,
  History,
  Loader2,
  Search,
  SearchX,
  SlidersHorizontal,
  TriangleAlert,
  X,
} from "lucide-vue-next";
import { useSearchStore } from "../stores/useSearchStore";
import { useTabsStore } from "../stores/useTabsStore";
import { usePersistenceStore } from "../stores/usePersistenceStore";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { basename, normalizePath } from "../utils/path";
import { isMarkdownFile } from "../utils/fileKind";
import { useShortcuts } from "../shortcuts/useShortcuts";
import {
  buildGroups,
  type SearchContentFileSource,
  type SearchEntry,
  type SearchFileSource,
  type SearchGroupKind,
  type SearchGroup,
} from "../search/searchLogic";
import type { TreeNode } from "../types";

const emit = defineEmits<{
  (e: "select", entry: SearchEntry): void;
  (e: "close"): void;
}>();

const { t } = useI18n();
const searchStore = useSearchStore();
const tabsStore = useTabsStore();
const persistence = usePersistenceStore();
const workspace = useWorkspaceStore();
const { effective } = useShortcuts();

// ===== 数据源（前端分组：标签 / 最近 / 文件名 / 内容命中） =====

/** 打开的标签 → SearchTabSource（打开顺序） */
const tabsSource = computed(() =>
  tabsStore.tabs.map((tab) => ({
    id: tab.id,
    path: tab.path,
    title: tabsStore.getTabTitle(tab),
  }))
);

/** 最近文件 → SearchRecentSource（最近时间倒序，仅文件） */
const recentsSource = computed(() =>
  persistence.recentEntries
    .filter((e) => e.type === "file")
    .slice()
    .sort((a, b) => b.openedAt - a.openedAt)
    .map((e) => ({ path: e.path, title: basename(e.path) }))
);

/** 递归展平文件树为文件列表（副标题用相对工作区目录） */
function flattenTree(nodes: TreeNode[]): SearchFileSource[] {
  const rootNorm = workspace.workspacePath
    ? normalizePath(workspace.workspacePath).replace(/\/$/, "")
    : null;
  const out: SearchFileSource[] = [];
  const walk = (list: TreeNode[]): void => {
    for (const node of list) {
      if (node.type === "file") {
        const normPath = normalizePath(node.path);
        let relativeDir = "";
        if (rootNorm && normPath.startsWith(rootNorm + "/")) {
          const rel = normPath.slice(rootNorm.length + 1);
          relativeDir = rel.split("/").slice(0, -1).join("/");
        }
        out.push({ path: node.path, title: node.name, relativeDir });
      }
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

const filesSource = computed(() => flattenTree(workspace.fileTree));

/** 内容命中 → SearchContentFileSource（Rust search_workspace 结果，行号升序） */
const contentSource = computed<SearchContentFileSource[]>(() =>
  searchStore.results.map((r) => ({
    path: r.filePath,
    title: basename(r.filePath),
    hits: r.matches
      .map((m) => ({ lineNumber: m.lineNumber, snippet: m.lineContent }))
      .sort((a, b) => a.lineNumber - b.lineNumber),
  }))
);

// ===== 分组 =====

const groups = computed<SearchGroup[]>(() =>
  buildGroups({
    query: searchStore.query,
    hasWorkspace: workspace.hasWorkspace,
    tabs: tabsSource.value,
    recents: recentsSource.value,
    files: filesSource.value,
    content: contentSource.value,
  })
);

/** 扁平条目（键盘导航用） */
const flatEntries = computed<SearchEntry[]>(() => {
  const out: SearchEntry[] = [];
  for (const g of groups.value) out.push(...g.items);
  return out;
});

const hasQuery = computed(() => searchStore.query.trim().length > 0);
const showEmpty = computed(
  () =>
    hasQuery.value &&
    !searchStore.loading &&
    flatEntries.value.length === 0 &&
    contentSource.value.length === 0
);

// ===== 键盘导航 =====

const inputRef = ref<HTMLInputElement | null>(null);
const optRegexRef = ref<HTMLInputElement | null>(null);
const itemEls = ref<Record<string, HTMLElement>>({});

const activeIndex = ref(-1);
const optionsOpen = ref(false);

// 结果变化时自动选中首项（保证「输入 → 回车打开」链路可用）
watch(flatEntries, (entries) => {
  if (entries.length === 0) {
    activeIndex.value = -1;
  } else if (activeIndex.value < 0 || activeIndex.value >= entries.length) {
    activeIndex.value = 0;
  }
});

function move(delta: number): void {
  const len = flatEntries.value.length;
  if (len === 0) {
    activeIndex.value = -1;
    return;
  }
  activeIndex.value = Math.min(
    len - 1,
    Math.max(0, (activeIndex.value < 0 ? (delta > 0 ? -1 : 0) : activeIndex.value) + delta)
  );
  nextTick(() => {
    const id = flatEntries.value[activeIndex.value]?.id;
    if (id) itemEls.value[id]?.scrollIntoView({ block: "nearest" });
  });
}

function selectEntry(entry: SearchEntry): void {
  emit("select", entry);
}

function selectActive(): void {
  const entry = flatEntries.value[activeIndex.value];
  if (entry) selectEntry(entry);
}

/** 判断条目是否为当前键盘选中项（activeIndex 是扁平索引，按 id 匹配） */
function isActiveItem(item: SearchEntry): boolean {
  if (activeIndex.value < 0) return false;
  return flatEntries.value[activeIndex.value]?.id === item.id;
}

function focusInput(): void {
  inputRef.value?.focus();
}

function focusFirstOption(): void {
  optionsOpen.value = true;
  nextTick(() => optRegexRef.value?.focus());
}

function onInputKeydown(e: KeyboardEvent): void {
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      move(1);
      break;
    case "ArrowUp":
      e.preventDefault();
      move(-1);
      break;
    case "Enter":
      e.preventDefault();
      selectActive();
      break;
    case "Tab":
      e.preventDefault();
      focusFirstOption();
      break;
    case "Escape":
      e.preventDefault();
      emit("close");
      break;
    default:
      break;
  }
}

// ===== 输入 / 选项 =====

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function onInput(value: string): void {
  searchStore.setQuery(value);
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void searchStore.search();
  }, 250);
}

function toggleOption(key: "regex" | "caseSensitive" | "wholeWord"): void {
  searchStore.setOptions({ [key]: !searchStore.options[key] });
  void searchStore.search();
}

function onClear(): void {
  searchStore.setQuery("");
  searchStore.results = [];
  void searchStore.cancelSearch();
  inputRef.value?.focus();
}

function onClose(): void {
  emit("close");
}

// ===== 高亮分段 =====

interface Seg {
  text: string;
  matched: boolean;
}

function splitSegments(text: string, ranges: [number, number][]): Seg[] {
  const safe = ranges.filter(([a, b]) => a >= 0 && b > a);
  if (!safe.length) return [{ text, matched: false }];
  const segs: Seg[] = [];
  let last = 0;
  for (const [a, b] of safe) {
    const start = Math.max(0, a);
    const end = Math.min(text.length, b);
    if (start > last) segs.push({ text: text.slice(last, start), matched: false });
    if (end > start) segs.push({ text: text.slice(start, end), matched: true });
    last = Math.max(last, end);
  }
  if (last < text.length) segs.push({ text: text.slice(last), matched: false });
  return segs;
}

// ===== 图标 / 徽标 =====

function groupIcon(kind: SearchGroupKind): typeof Search {
  switch (kind) {
    case "tabs":
      return Files;
    case "recent":
      return History;
    case "content":
      return Search;
    case "files":
    default:
      return FileText;
  }
}

function groupLabel(kind: SearchGroupKind): string {
  const key: Record<SearchGroupKind, string> = {
    tabs: "groupTabs",
    recent: "groupRecent",
    files: "groupFiles",
    content: "groupContent",
  };
  return t(`editor.searchBar.${key[kind]}`);
}

function titleLead(path: string | null): "md" | "html" | "none" {
  if (!path) return "none";
  if (isMarkdownFile(path)) return "md";
  if (/\.html?$/i.test(path)) return "html";
  return "none";
}

/** 当前分组需要展示的 chip 类型（tabs=「已打开」、recent=「最近」；其余无 chip） */
function groupChip(kind: SearchGroupKind): "tabs" | "recent" | null {
  if (kind === "tabs") return "tabs";
  if (kind === "recent") return "recent";
  return null;
}

const shortcutLabel = computed(() => effective.value["global-search"] ?? "Ctrl+P");

// 打开时：聚焦输入框 + 清空上一次查询（空查询默认态）
onMounted(() => {
  searchStore.clear();
  inputRef.value?.focus();
});

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
});

// 关闭（Esc / 遮罩）后由 App 恢复编辑器焦点；这里仅在 input 有值且关闭时无需额外处理
watch(
  () => searchStore.visible,
  (v) => {
    if (!v && debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }
);
</script>

<template>
  <div class="gsb-overlay" @click.self="onClose">
    <div class="gsb" role="dialog" :aria-label="t('editor.searchBar.aria')">
      <!-- 输入行 -->
      <div class="gsb__input">
        <span class="gsb__searchicon">
          <Search :size="16" aria-hidden="true" />
        </span>
        <input
          ref="inputRef"
          :value="searchStore.query"
          type="text"
          :placeholder="t('editor.searchBar.placeholder')"
          autocomplete="off"
          spellcheck="false"
          @input="onInput(($event.target as HTMLInputElement).value)"
          @keydown="onInputKeydown"
        />
        <button
          class="gsb__optbtn"
          :class="{ 'is-on': optionsOpen }"
          type="button"
          :title="t('editor.searchBar.optRegex')"
          @click="optionsOpen = !optionsOpen"
        >
          <SlidersHorizontal :size="14" aria-hidden="true" />
        </button>
        <kbd class="gsb-kbd">{{ shortcutLabel }}</kbd>
        <button
          v-if="searchStore.query"
          class="gsb__clear"
          type="button"
          :title="t('editor.searchBar.clear')"
          @click="onClear"
        >
          <X :size="12" aria-hidden="true" />
        </button>
      </div>

      <!-- 高级选项（仅作用于内容命中） -->
      <div class="gsb__options" :class="{ 'is-open': optionsOpen }">
        <label class="gsb-opt">
          <span class="gsb-switch">
            <input
              ref="optRegexRef"
              type="checkbox"
              :checked="searchStore.options.regex"
              @change="toggleOption('regex')"
              @keydown.tab.prevent="focusInput"
            />
            <span class="gsb-switch__thumb"></span>
          </span>
          <span class="gsb-optcode">.*</span>&nbsp;{{ t('editor.searchBar.optRegex') }}
        </label>
        <label class="gsb-opt">
          <span class="gsb-switch">
            <input
              type="checkbox"
              :checked="searchStore.options.caseSensitive"
              @change="toggleOption('caseSensitive')"
              @keydown.tab.prevent="focusInput"
            />
            <span class="gsb-switch__thumb"></span>
          </span>
          <span class="gsb-optcode">Aa</span>&nbsp;{{ t('editor.searchBar.optCase') }}
        </label>
        <label class="gsb-opt">
          <span class="gsb-switch">
            <input
              type="checkbox"
              :checked="searchStore.options.wholeWord"
              @change="toggleOption('wholeWord')"
              @keydown.tab.prevent="focusInput"
            />
            <span class="gsb-switch__thumb"></span>
          </span>
          <span class="gsb-optcode">|w|</span>&nbsp;{{ t('editor.searchBar.optWord') }}
        </label>
        <span class="gsb__options-note">{{ t('editor.searchBar.optionsNote') }}</span>
      </div>

      <!-- 结果区 -->
      <div class="gsb__results">
        <!-- 空态 -->
        <div v-if="showEmpty" class="gsb__empty">
          <SearchX :size="20" class="gsb__empty-icon" aria-hidden="true" />
          <span>{{ t('editor.searchBar.emptyNoResults') }}</span>
          <span class="gsb__empty__hint">{{ t('editor.searchBar.emptyHint') }}</span>
        </div>

        <!-- 分组 -->
        <template v-else>
          <div v-for="g in groups" :key="g.kind" class="gsb__group">
            <div class="gsb__group-label">
              <span>{{ groupLabel(g.kind) }}</span>
              <span class="gsb__group-count">{{ g.items.length }}</span>
            </div>
            <div
              v-for="item in g.items"
              :key="item.id"
              :ref="(el) => { if (el) itemEls[item.id] = el as HTMLElement; }"
              class="gsb__item"
              :class="{ 'is-active': isActiveItem(item) }"
              :title="item.path ?? item.title"
              @click="selectEntry(item)"
            >
              <span class="gsb__item__icon" :class="`gsb__item__icon--${g.kind}`">
                <component :is="groupIcon(g.kind)" :size="14" aria-hidden="true" />
              </span>
              <span class="gsb__item__body">
                <span class="gsb__item__title">
                  <span v-if="titleLead(item.path) === 'md'" class="gsb-md-badge">M</span>
                  <span v-else-if="titleLead(item.path) === 'html'" class="gsb-html-icon">
                    <Code2 :size="13" aria-hidden="true" />
                  </span>
                  <template v-for="(seg, sIdx) in splitSegments(item.title, item.ranges)" :key="sIdx">
                    <mark v-if="seg.matched" class="gsb-hl">{{ seg.text }}</mark>
                    <template v-else>{{ seg.text }}</template>
                  </template>
                </span>
                <span v-if="item.subtitle" class="gsb__item__sub">{{ item.subtitle }}</span>
                <span v-if="item.snippet !== undefined" class="gsb__snippet">
                  <span class="gsb__snippet__ln">{{ item.lineNumber }}</span>
                  <span class="gsb__snippet__text">
                    <template v-for="(seg, pIdx) in splitSegments(item.snippet ?? '', item.snippetRanges ?? [])" :key="pIdx">
                      <mark v-if="seg.matched" class="gsb-hl">{{ seg.text }}</mark>
                      <template v-else>{{ seg.text }}</template>
                    </template>
                  </span>
                </span>
              </span>
              <span class="gsb__item__meta">
                <span v-if="groupChip(g.kind) === 'tabs'" class="gsb-chip gsb-chip--tab">
                  {{ t('editor.searchBar.chipOpen') }}
                </span>
                <span v-else-if="groupChip(g.kind) === 'recent'" class="gsb-chip">
                  {{ t('editor.searchBar.chipRecent') }}
                </span>
              </span>
            </div>
          </div>

          <!-- 内容扫描加载中 -->
          <div
            v-if="searchStore.loading && hasQuery && workspace.hasWorkspace && contentSource.length === 0"
            class="gsb__loading"
            role="status"
            aria-live="polite"
            aria-busy="true"
          >
            <span class="gsb__spinner" aria-hidden="true"></span>
            <span>{{ t('editor.searchBar.loadingScan') }}</span>
          </div>
        </template>
      </div>

      <!-- 截断提示 -->
      <div v-if="searchStore.truncated" class="gsb__truncate">
        <TriangleAlert :size="12" class="gsb__truncate__icon" aria-hidden="true" />
        <span>{{ t('editor.searchBar.truncated') }}</span>
      </div>

      <!-- 底部提示 -->
      <div class="gsb__footer">
        <span class="gsb-kbd__combo"><kbd class="gsb-kbd">↑</kbd><kbd class="gsb-kbd">↓</kbd></span>&nbsp;{{ t('editor.searchBar.hintSelect') }}
        <span class="gsb-kbd__combo"><kbd class="gsb-kbd">⏎</kbd></span>&nbsp;{{ t('editor.searchBar.hintOpen') }}
        <span class="gsb-kbd__combo"><kbd class="gsb-kbd">Esc</kbd></span>&nbsp;{{ t('editor.searchBar.hintClose') }}
        <Loader2
          v-if="searchStore.loading"
          :size="11"
          class="gsb__footer__spinner"
          aria-hidden="true"
        />
        <span class="gsb__footer__count">
          {{ t('editor.searchBar.resultCount', { count: flatEntries.length }) }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 遮罩：dim 底层，点击空白关闭 */
.gsb-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(15, 23, 42, 0.28);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 9vh;
}

.gsb {
  width: 620px;
  max-width: calc(100vw - 64px);
  background: var(--murasaki-popover);
  border: 1px solid var(--murasaki-border);
  border-radius: var(--murasaki-radius-md);
  box-shadow: var(--murasaki-shadow-2);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: gsb-in var(--murasaki-duration-base) var(--murasaki-ease-out);
}

@keyframes gsb-in {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}

/* —— 输入行 —— */
.gsb__input {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 46px;
  padding: 0 14px;
  background: var(--murasaki-background);
  border-bottom: 1px solid var(--murasaki-border);
  border-radius: var(--murasaki-radius-md) var(--murasaki-radius-md) 0 0;
}
.gsb__input:focus-within {
  box-shadow: 0 0 0 2px var(--murasaki-ring);
  border-color: var(--murasaki-ring);
}
.gsb__searchicon {
  display: inline-flex;
  color: var(--murasaki-ink-3);
  flex: 0 0 auto;
}
.gsb__input input {
  flex: 1;
  min-width: 0;
  height: 100%;
  background: transparent;
  border: none;
  outline: none;
  color: var(--murasaki-ink);
  font: inherit;
  font-size: 14px;
}
.gsb__input input::placeholder { color: var(--murasaki-ink-3); }
.gsb__optbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--murasaki-radius-sm);
  background: transparent;
  color: var(--murasaki-ink-3);
  cursor: pointer;
  flex: 0 0 auto;
}
.gsb__optbtn:hover { background: var(--murasaki-muted); color: var(--murasaki-ink-2); }
.gsb__optbtn.is-on { background: var(--murasaki-purple-100); color: var(--murasaki-purple-700); }
.gsb__clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--murasaki-radius-sm);
  background: transparent;
  color: var(--murasaki-ink-3);
  cursor: pointer;
  flex: 0 0 auto;
}
.gsb__clear:hover { background: var(--murasaki-muted); color: var(--murasaki-ink-2); }

/* kbd */
.gsb-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  font-family: var(--murasaki-font-mono);
  font-size: 10px;
  line-height: 1;
  font-weight: 500;
  color: var(--murasaki-ink-2);
  background: var(--murasaki-muted);
  border: 1px solid var(--murasaki-neutral-200);
  border-bottom-width: 2px;
  border-radius: var(--murasaki-radius-sm);
}
.gsb-kbd__combo { display: inline-flex; align-items: center; gap: 3px; }

/* —— 高级选项行 —— */
.gsb__options {
  display: none;
  align-items: center;
  gap: 16px;
  padding: 8px 14px;
  background: var(--murasaki-surface);
  border-bottom: 1px solid var(--murasaki-border);
}
.gsb__options.is-open { display: flex; }
.gsb-opt {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--murasaki-ink-2);
  cursor: pointer;
  user-select: none;
}
.gsb-opt:hover { color: var(--murasaki-ink); }
.gsb-optcode {
  font-family: var(--murasaki-font-mono);
  font-size: 11px;
  color: inherit;
  font-weight: 500;
}
.gsb__options-note {
  margin-left: auto;
  font-size: 11px;
  color: var(--murasaki-ink-3);
}

/* 紧凑开关 */
.gsb-switch {
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
  width: 30px;
  height: 17px;
  background: var(--murasaki-neutral-300);
  border-radius: 11px;
  transition: background var(--murasaki-duration-fast);
}
.gsb-switch input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  margin: 0;
  cursor: pointer;
}
.gsb-switch:focus-within { box-shadow: 0 0 0 2px var(--murasaki-ring); }
.gsb-switch__thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--murasaki-background);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
  transition: transform var(--murasaki-duration-fast);
  pointer-events: none;
}
.gsb-switch input:checked + .gsb-switch__thumb { transform: translateX(13px); }
.gsb-switch:has(input:checked) { background: var(--murasaki-primary); }

/* —— 结果区 —— */
.gsb__results {
  max-height: 408px;
  overflow-y: auto;
  padding: 4px;
}
.gsb__results::-webkit-scrollbar { width: 8px; }
.gsb__results::-webkit-scrollbar-thumb { background: var(--murasaki-neutral-300); border-radius: 4px; }

.gsb__group-label {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 8px 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--murasaki-ink-3);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.gsb__group-count {
  flex: 0 0 auto;
  background: var(--murasaki-muted);
  color: var(--murasaki-muted-foreground);
  border-radius: 8px;
  padding: 0 6px;
  font-size: 10px;
  min-width: 16px;
  text-align: center;
}

.gsb__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--murasaki-radius-sm);
  cursor: pointer;
  transition: background var(--murasaki-duration-fast) var(--murasaki-ease);
}
.gsb__item:hover { background: rgba(147, 51, 234, 0.08); }
.gsb__item.is-active { background: rgba(147, 51, 234, 0.1); }
.gsb__item.is-active .gsb__item__title { color: var(--murasaki-primary); font-weight: 500; }
.gsb__item.is-active .gsb__item__sub,
.gsb__item.is-active .gsb__snippet { color: var(--murasaki-ink-2); }

.gsb__item__icon {
  display: inline-flex;
  flex: 0 0 auto;
  color: var(--murasaki-ink-3);
}
.gsb__item__icon--tabs { color: var(--murasaki-purple-600); }
.gsb__item__icon--content { color: var(--murasaki-purple-600); }

.gsb__item__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.gsb__item__title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--murasaki-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gsb__item__sub {
  font-size: 11px;
  color: var(--murasaki-ink-3);
  font-family: var(--murasaki-font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gsb__item__meta {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 匹配高亮（对齐 SearchPanel .match-highlight） */
.gsb-hl {
  background: rgba(147, 51, 234, 0.2);
  color: var(--murasaki-purple-800);
  border-radius: 2px;
  padding: 0 1px;
  font-weight: 500;
}

/* 内容命中行 */
.gsb__snippet {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--murasaki-font-mono);
  font-size: 12px;
  color: var(--murasaki-ink-2);
  white-space: nowrap;
  overflow: hidden;
}
.gsb__snippet__ln {
  flex: 0 0 auto;
  color: var(--murasaki-ink-3);
  min-width: 20px;
  text-align: right;
  user-select: none;
}
.gsb__snippet__text {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 徽标 / chip */
.gsb-md-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  border-radius: var(--murasaki-radius-sm);
  background: var(--murasaki-purple-100);
  color: var(--murasaki-purple-700);
  font-family: var(--murasaki-font-mono);
  font-weight: 700;
  font-size: 10px;
}
.gsb-html-icon {
  display: inline-flex;
  flex: 0 0 auto;
  color: var(--murasaki-purple-500);
}
.gsb-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 17px;
  padding: 0 7px;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.02em;
  color: var(--murasaki-ink-2);
  background: var(--murasaki-muted);
  white-space: nowrap;
}
.gsb-chip--tab { background: var(--murasaki-purple-100); color: var(--murasaki-purple-700); }
.gsb__item.is-active .gsb-chip--tab { background: var(--murasaki-purple-600); color: #fff; }
.gsb__item.is-active .gsb-chip { background: var(--murasaki-purple-100); color: var(--murasaki-purple-700); }

/* —— 空态 / 加载态 —— */
.gsb__empty,
.gsb__loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 36px 16px;
  color: var(--murasaki-ink-3);
  font-size: 13px;
}
.gsb__empty-icon { color: var(--murasaki-ink-3); }
.gsb__empty__hint { font-size: 11px; color: var(--murasaki-ink-3); }
.gsb__spinner {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid var(--murasaki-purple-200);
  border-top-color: var(--murasaki-primary);
  animation: gsb-spin 0.7s linear infinite;
}
@keyframes gsb-spin { to { transform: rotate(360deg); } }

/* —— 截断提示 —— */
.gsb__truncate {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 8px;
  padding: 4px 8px;
  background: color-mix(in srgb, var(--murasaki-state-warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--murasaki-state-warning) 24%, transparent);
  border-radius: var(--murasaki-radius-sm);
  font-size: 11px;
  color: var(--murasaki-ink-2);
}
.gsb__truncate__icon { color: var(--murasaki-state-warning); flex: 0 0 auto; }

/* —— 底部提示 —— */
.gsb__footer {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 14px;
  background: var(--murasaki-card);
  border-top: 1px solid var(--murasaki-border);
  font-size: 11px;
  color: var(--murasaki-ink-3);
}
.gsb__footer .gsb-kbd { min-width: 16px; height: 16px; font-size: 9px; }
.gsb__footer__spinner {
  animation: gsb-spin 1s linear infinite;
  color: var(--murasaki-primary);
}
.gsb__footer__count {
  margin-left: auto;
  font-family: var(--murasaki-font-mono);
  font-size: 11px;
  color: var(--murasaki-ink-2);
}
</style>
