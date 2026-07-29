<script setup lang="ts">
import { computed, watch } from "vue";
import { FileText } from "lucide-vue-next";
import { NInput, NCheckbox, NButton, NScrollbar, NSpin, NEmpty } from "naive-ui";
import { useSearchStore } from "../stores/useSearchStore";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import type { SearchResult } from "../types";

const searchStore = useSearchStore();
const workspace = useWorkspaceStore();

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

const hasResults = computed(
  () =>
    (searchStore.results.length > 0 ||
      searchStore.filenameResults.length > 0) &&
    !searchStore.loading
);

const showEmpty = computed(
  () =>
    !searchStore.loading &&
    searchStore.results.length === 0 &&
    searchStore.filenameResults.length === 0 &&
    searchStore.query.trim() !== ""
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
        placeholder="搜索工作区内容…"
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
          正则
        </NCheckbox>
        <NCheckbox
          :checked="searchStore.options.caseSensitive"
          size="small"
          @update:checked="onToggleCaseSensitive"
        >
          大小写
        </NCheckbox>
        <NCheckbox
          :checked="searchStore.options.wholeWord"
          size="small"
          @update:checked="onToggleWholeWord"
        >
          全词
        </NCheckbox>
      </div>
      <span v-if="hasResults" class="search-summary">
        {{ searchStore.results.length + searchStore.filenameResults.length }} 个文件 / {{ totalMatches }} 处匹配
      </span>
      <NButton
        size="tiny"
        quaternary
        circle
        title="关闭"
        class="close-btn"
        @click="onClose"
      >
        ×
      </NButton>
    </div>

    <!-- 结果区 -->
    <div class="search-results">
      <NScrollbar>
        <div v-if="searchStore.loading" class="results-loading">
          <NSpin size="small" />
          <span style="margin-left: 8px; font-size: 12px; color: #999">
            搜索中…
          </span>
        </div>
        <NEmpty
          v-else-if="showEmpty"
          description="无匹配结果"
          size="small"
          style="padding: 24px 0"
        />
        <div v-else-if="hasResults" class="results-content">
          <!-- 文件名匹配分组（展示在内容匹配之前） -->
          <div
            v-if="groupedFilenameResults.length > 0"
            class="result-group filename-group"
          >
            <div class="group-header filename-header">
              <span class="group-path">文件名匹配</span>
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

          <!-- 内容匹配分组 -->
          <div
            v-for="group in groupedResults"
            :key="group.filePath"
            class="result-group"
          >
            <div class="group-header" :title="group.filePath">
              <span class="group-path">{{ group.displayPath }}</span>
              <span class="group-count">{{ group.matches.length }}</span>
            </div>
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
  background: #fff;
}
.search-toolbar {
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  border-bottom: 1px solid #eee;
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
  color: #999;
  flex-shrink: 0;
  white-space: nowrap;
}
.close-btn {
  flex-shrink: 0;
  font-size: 16px;
}
.search-results {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.results-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 0;
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
  background: #fafafa;
  border-bottom: 1px solid #f0f0f0;
  font-size: 12px;
  color: #555;
  position: sticky;
  top: 0;
  z-index: 1;
}
.group-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: "Consolas", "Menlo", monospace;
}
.group-count {
  flex-shrink: 0;
  background: #e8e8e8;
  color: #666;
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
  color: #333;
  transition: background 0.1s;
}
.match-line:hover {
  background: rgba(24, 160, 88, 0.08);
}
.line-number {
  flex-shrink: 0;
  color: #999;
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
  background: #fff3a0;
  color: inherit;
  padding: 0;
  border-radius: 2px;
}

/* ===== 文件名匹配分组 ===== */
.filename-group {
  margin-bottom: 8px;
  border-bottom: 1px solid #f0f0f0;
  padding-bottom: 4px;
}
.filename-header {
  background: #f0f7ff !important;
  color: #1f6feb !important;
  font-weight: 600;
}
.filename-line {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  cursor: pointer;
  font-size: 12px;
  color: #333;
  transition: background 0.1s;
}
.filename-line:hover {
  background: rgba(24, 160, 88, 0.08);
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
  color: #24292e;
}
.filename-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #999;
  font-size: 11px;
  font-family: "Consolas", "Menlo", monospace;
}
</style>
