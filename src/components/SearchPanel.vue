<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Loader2,
  SearchX,
  Square,
  TriangleAlert,
} from "lucide-vue-next";
import { NInput, NCheckbox, NButton, NScrollbar } from "naive-ui";
import EmptyState from "./EmptyState.vue";
import Skeleton from "./Skeleton.vue";
import { useSearchStore } from "../stores/useSearchStore";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import type { SearchResult } from "../types";

const searchStore = useSearchStore();
const workspace = useWorkspaceStore();
const { t } = useI18n();

const emit = defineEmits<{
  (e: "select-file", path: string, line: number): void;
  (e: "close"): void;
}>();

// ===== 防抖搜索 =====
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function onInput(value: string): void {
  searchStore.setQuery(value);
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    void searchStore.search();
  }, 250);
}

// ===== 相对路径展示 =====
/**
 * 将绝对路径转换为相对工作区根的路径（用于展示）
 */
function relativePath(filePath: string): string {
  const root = workspace.workspacePath;
  if (!root) return filePath;
  const normRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  const normPath = filePath.replace(/\\/g, "/");
  if (normPath.startsWith(normRoot + "/")) {
    return normPath.slice(normRoot.length + 1);
  }
  return filePath;
}

// ===== 关键词高亮 =====
/**
 * 构造用于高亮匹配的正则表达式
 * - regex 模式：直接使用用户输入
 * - 普通模式：转义特殊字符
 * - wholeWord 模式：包裹 \b 边界
 * - caseSensitive 控制是否加 i 标志
 */
function buildHighlightRegex(): RegExp | null {
  const q = searchStore.query.trim();
  if (!q) return null;
  const opts = searchStore.options;
  let pattern: string;
  if (opts.regex) {
    pattern = q;
  } else {
    pattern = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  if (opts.wholeWord) {
    pattern = `\\b${pattern}\\b`;
  }
  try {
    return new RegExp(pattern, opts.caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

interface HighlightSegment {
  text: string;
  matched: boolean;
}

/**
 * 将一行文本按匹配项分段，用于渲染高亮
 */
function highlightLine(line: string): HighlightSegment[] {
  const regex = buildHighlightRegex();
  if (!regex) return [{ text: line, matched: false }];
  const segments: HighlightSegment[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  // 重置 lastIndex（全局正则）
  regex.lastIndex = 0;
  while ((m = regex.exec(line)) !== null) {
    if (m.index > lastIndex) {
      segments.push({ text: line.slice(lastIndex, m.index), matched: false });
    }
    segments.push({ text: m[0], matched: true });
    lastIndex = m.index + m[0].length;
    // 防止零宽匹配死循环
    if (m[0].length === 0) {
      regex.lastIndex++;
    }
  }
  if (lastIndex < line.length) {
    segments.push({ text: line.slice(lastIndex), matched: false });
  }
  return segments;
}

// ===== 结果分组 =====
interface GroupedResult {
  filePath: string;
  displayPath: string;
  matches: SearchResult["matches"];
}

const groupedResults = computed<GroupedResult[]>(() => {
  return searchStore.results.map((r) => ({
    filePath: r.filePath,
    displayPath: relativePath(r.filePath),
    matches: r.matches,
  }));
});

/** 文件名匹配展示项 */
interface FilenameDisplay {
  filePath: string;
  displayPath: string;
  fileName: string;
}

const groupedFilenameResults = computed<FilenameDisplay[]>(() => {
  return searchStore.filenameResults.map((filePath: string) => {
    const displayPath = relativePath(filePath);
    const fileName = displayPath.split(/[/\\]/).pop() ?? displayPath;
    return { filePath, displayPath, fileName };
  });
});

const totalMatches = computed(() => {
  return searchStore.results.reduce(
    (sum, r) => sum + r.matches.length,
    0
  );
});

/**
 * 是否有任何结果（含增量）—— 与 loading 状态独立
 * 用于决定 Skeleton vs 结果列表 vs 空态
 */
const hasAnyResults = computed(
  () =>
    searchStore.results.length > 0 || searchStore.filenameResults.length > 0
);

const hasResults = computed(() => hasAnyResults.value && !searchStore.loading);

const showEmpty = computed(
  () =>
    !searchStore.loading &&
    searchStore.results.length === 0 &&
    searchStore.filenameResults.length === 0 &&
    searchStore.query.trim() !== ""
);

/**
 * 进度文本：搜索中显示扫描进度与命中数
 * 完成后显示文件数与命中数（无 total_files）
 */
const progressText = computed<string>(() => {
  if (searchStore.loading) {
    const total = searchStore.totalFiles;
    const scanned = searchStore.scannedFiles;
    const matched = searchStore.matchedCount;
    if (total > 0) {
      return t("editor.search.scanningProgress", { scanned, total, matched });
    }
    return t("editor.search.scanning", { matched });
  }
  if (hasResults.value) {
    return t("editor.search.resultSummary", {
      files: searchStore.results.length + searchStore.filenameResults.length,
      matches: totalMatches.value,
    });
  }
  return "";
});

// ===== 折叠/展开 =====
/**
 * 折叠的文件路径集合（用户主动折叠的）
 * 默认行为：前 DEFAULT_EXPANDED 个文件展开，其余折叠
 */
const DEFAULT_EXPANDED = 3;
const collapsedFiles = ref<Set<string>>(new Set());

/**
 * 判断分组是否应展开
 * - 用户显式折叠（在 collapsedFiles 中）→ 折叠
 * - 用户显式展开（不在 collapsedFiles 中）→ 展开
 * 初始：前 DEFAULT_EXPANDED 个展开，其余自动折叠
 */
function isGroupExpanded(filePath: string, index: number): boolean {
  if (collapsedFiles.value.has(filePath)) return false;
  // 未在 collapsed 集合中：默认前 N 个展开，其余折叠
  // 但只要用户曾经操作过（集合非空），就以集合为准
  if (collapsedFiles.value.size === 0 && index >= DEFAULT_EXPANDED) {
    return false;
  }
  return true;
}

function toggleGroup(filePath: string): void {
  const next = new Set(collapsedFiles.value);
  if (next.has(filePath)) {
    next.delete(filePath);
  } else {
    next.add(filePath);
  }
  collapsedFiles.value = next;
}

// 搜索开始时重置折叠状态
watch(
  () => searchStore.cancelToken,
  () => {
    collapsedFiles.value = new Set();
  }
);

// ===== 选项切换 =====
function onToggleRegex(value: boolean): void {
  searchStore.setOptions({ regex: value });
  void searchStore.search();
}

function onToggleCaseSensitive(value: boolean): void {
  searchStore.setOptions({ caseSensitive: value });
  void searchStore.search();
}

function onToggleWholeWord(value: boolean): void {
  searchStore.setOptions({ wholeWord: value });
  void searchStore.search();
}

// ===== 关闭 =====
function onClose(): void {
  emit("close");
}

// ===== 清空搜索（无结果态操作）=====
function onClearSearch(): void {
  searchStore.clear();
}

// ===== 取消搜索 =====
function onCancelSearch(): void {
  void searchStore.cancelSearch();
}

// ===== 选中匹配行 =====
function onSelectMatch(filePath: string, lineNumber: number): void {
  emit("select-file", filePath, lineNumber);
}

// ===== 选中文件名匹配项（无具体行号，跳到第 1 行）=====
function onSelectFilename(filePath: string): void {
  emit("select-file", filePath, 1);
}

/**
 * 高亮文件名中的匹配片段（与内容高亮共用同一规则）
 */
function highlightFilename(fileName: string): HighlightSegment[] {
  return highlightLine(fileName);
}

// 当面板隐藏时清空查询（避免下次打开看到旧结果）
watch(
  () => searchStore.visible,
  (v) => {
    if (!v) {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    }
  }
);
</script>

<template>
  <div class="search-panel">
    <!-- 顶部工具栏 -->
    <div class="search-toolbar">
      <NInput
        :value="searchStore.query"
        size="small"
        :placeholder="$t('editor.search.placeholder')"
        clearable
        class="search-input"
        @update:value="onInput"
      />
      <div class="search-options">
        <NCheckbox
          :checked="searchStore.options.regex"
          size="small"
          @update:checked="onToggleRegex"
        >
          {{ $t('editor.search.regex') }}
        </NCheckbox>
        <NCheckbox
          :checked="searchStore.options.caseSensitive"
          size="small"
          @update:checked="onToggleCaseSensitive"
        >
          {{ $t('editor.search.caseSensitive') }}
        </NCheckbox>
        <NCheckbox
          :checked="searchStore.options.wholeWord"
          size="small"
          @update:checked="onToggleWholeWord"
        >
          {{ $t('editor.search.wholeWord') }}
        </NCheckbox>
      </div>
      <span v-if="progressText" class="search-summary">
        <Loader2
          v-if="searchStore.loading"
          :size="11"
          class="spinner-icon"
          aria-hidden="true"
        />
        {{ progressText }}
      </span>
      <NButton
        v-if="searchStore.loading"
        size="tiny"
        quaternary
        :title="$t('editor.search.cancelSearch')"
        class="cancel-btn"
        @click="onCancelSearch"
      >
        <Square :size="11" aria-hidden="true" />
      </NButton>
      <NButton
        size="tiny"
        quaternary
        circle
        :title="$t('editor.search.close')"
        class="close-btn"
        @click="onClose"
      >
        ×
      </NButton>
    </div>

    <!-- 截断提示 -->
    <div v-if="searchStore.truncated" class="truncation-banner">
      <TriangleAlert :size="12" class="truncation-icon" aria-hidden="true" />
      <span>{{ $t('editor.search.truncated') }}</span>
    </div>

    <!-- 结果区 -->
    <div class="search-results">
      <NScrollbar>
        <Skeleton v-if="searchStore.loading && !hasAnyResults" :lines="4" :icon="FileText" />
        <EmptyState
          v-else-if="showEmpty"
          :icon="SearchX"
          :title="$t('editor.search.noResults')"
          :action-text="$t('editor.search.clearSearch')"
          @action="onClearSearch"
        />
        <div v-else-if="hasAnyResults" class="results-content">
          <!-- 文件名匹配分组（展示在内容匹配之前） -->
          <div
            v-if="groupedFilenameResults.length > 0"
            class="result-group filename-group"
          >
            <div class="group-header filename-header">
              <span class="group-path">{{ $t('editor.search.filenameMatches') }}</span>
              <span class="group-count">{{ groupedFilenameResults.length }}</span>
            </div>
            <div
              v-for="item in groupedFilenameResults"
              :key="item.filePath"
              class="match-line filename-line"
              :title="item.filePath"
              @click="onSelectFilename(item.filePath)"
            >
              <FileText :size="14" class="filename-icon" aria-hidden="true" />
              <span class="filename-name">
                <template
                  v-for="(seg, sIdx) in highlightFilename(item.fileName)"
                  :key="sIdx"
                >
                  <mark v-if="seg.matched" class="match-highlight">{{
                    seg.text
                  }}</mark>
                  <template v-else>{{ seg.text }}</template>
                </template>
              </span>
              <span class="filename-path">{{ item.displayPath }}</span>
            </div>
          </div>

          <!-- 内容匹配分组（可折叠） -->
          <div
            v-for="(group, gIdx) in groupedResults"
            :key="group.filePath"
            class="result-group"
          >
            <div
              class="group-header group-header--clickable"
              :title="group.filePath"
              @click="toggleGroup(group.filePath)"
            >
              <component
                :is="isGroupExpanded(group.filePath, gIdx) ? ChevronDown : ChevronRight"
                :size="12"
                class="chevron-icon"
                aria-hidden="true"
              />
              <span class="group-path">{{ group.displayPath }}</span>
              <span class="group-count">{{ group.matches.length }}</span>
            </div>
            <div
              v-if="isGroupExpanded(group.filePath, gIdx)"
              class="group-matches"
            >
              <div
                v-for="(match, idx) in group.matches"
                :key="idx"
                class="match-line"
                @click="onSelectMatch(group.filePath, match.lineNumber)"
              >
                <span class="line-number">{{ match.lineNumber }}</span>
                <span class="line-content">
                  <template
                    v-for="(seg, sIdx) in highlightLine(match.lineContent)"
                    :key="sIdx"
                  >
                    <mark v-if="seg.matched" class="match-highlight">{{
                      seg.text
                    }}</mark>
                    <template v-else>{{ seg.text }}</template>
                  </template>
                </span>
              </div>
            </div>
          </div>
        </div>
      </NScrollbar>
    </div>
  </div>
</template>

<style scoped>
.search-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--murasaki-background);
}
.search-toolbar {
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  border-bottom: 1px solid var(--murasaki-border);
}
.search-input {
  flex: 1;
  min-width: 0;
}
.search-options {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  font-size: 12px;
}
.search-options :deep(.n-checkbox) {
  --n-size: 14px;
}
.search-summary {
  font-size: 11px;
  color: var(--murasaki-muted-foreground);
  flex-shrink: 0;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.spinner-icon {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
.cancel-btn,
.close-btn {
  flex-shrink: 0;
}
.close-btn {
  font-size: 16px;
}
.truncation-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  background: color-mix(in srgb, var(--murasaki-warning, #f59e0b) 12%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--murasaki-warning, #f59e0b) 30%, transparent);
  color: var(--murasaki-foreground);
  font-size: 11px;
  flex-shrink: 0;
}
.truncation-icon {
  color: var(--murasaki-warning, #f59e0b);
  flex-shrink: 0;
}
.search-results {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.results-content {
  padding: 4px 0;
}
.result-group {
  margin-bottom: 4px;
}
.group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 12px;
  background: var(--murasaki-card);
  border-bottom: 1px solid var(--murasaki-border);
  font-size: 12px;
  color: var(--murasaki-ink-2);
  position: sticky;
  top: 0;
  z-index: 1;
}
.group-header--clickable {
  cursor: pointer;
  user-select: none;
}
.group-header--clickable:hover {
  background: color-mix(in srgb, var(--murasaki-primary) 6%, var(--murasaki-card));
}
.chevron-icon {
  flex-shrink: 0;
  color: var(--murasaki-muted-foreground);
}
.group-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: "Consolas", "Menlo", monospace;
  flex: 1;
  min-width: 0;
}
.group-count {
  flex-shrink: 0;
  background: var(--murasaki-muted);
  color: var(--murasaki-muted-foreground);
  border-radius: 8px;
  padding: 0 6px;
  font-size: 10px;
  min-width: 16px;
  text-align: center;
}
.match-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 2px 12px;
  cursor: pointer;
  font-size: 12px;
  color: var(--murasaki-foreground);
  transition: background 0.1s;
}
.match-line:hover {
  background: rgba(147, 51, 234, 0.08);
}
.line-number {
  flex-shrink: 0;
  color: var(--murasaki-muted-foreground);
  font-family: "Consolas", "Menlo", monospace;
  min-width: 32px;
  text-align: right;
  user-select: none;
  padding-top: 1px;
}
.line-content {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: "Consolas", "Menlo", monospace;
}
.match-highlight {
  background: rgba(147, 51, 234, 0.2);
  color: var(--murasaki-primary-foreground);
  padding: 0 2px;
  border-radius: 2px;
}

/* 搜索当前项：hover 行内的匹配关键词加深到 40% alpha */
.match-line:hover .match-highlight,
.filename-line:hover .match-highlight {
  background: rgba(147, 51, 234, 0.4);
}

/* ===== 文件名匹配分组 ===== */
.filename-group {
  margin-bottom: 8px;
  border-bottom: 1px solid var(--murasaki-border);
  padding-bottom: 4px;
}
.filename-header {
  background: rgba(147, 51, 234, 0.08) !important;
  color: var(--murasaki-primary) !important;
  font-weight: 600;
}
.filename-line {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  cursor: pointer;
  font-size: 12px;
  color: var(--murasaki-foreground);
  transition: background 0.1s;
}
.filename-line:hover {
  background: rgba(147, 51, 234, 0.08);
}
.filename-icon {
  flex-shrink: 0;
  font-size: 14px;
  user-select: none;
}
.filename-name {
  flex-shrink: 0;
  font-family: "Consolas", "Menlo", monospace;
  font-weight: 500;
  color: var(--murasaki-foreground);
}
.filename-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--murasaki-muted-foreground);
  font-size: 11px;
  font-family: "Consolas", "Menlo", monospace;
}
</style>
