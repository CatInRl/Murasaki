<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { NModal, NButton, NSpace, NText, NTag, NScrollbar } from "naive-ui";
import { diff_match_patch } from "diff-match-patch";

interface Props {
  visible: boolean;
  /** 文件绝对路径 */
  filePath: string;
  /** 外部版本内容（磁盘最新） */
  externalContent: string;
  /** 本地版本内容（编辑器当前） */
  localContent: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: "close"): void;
  /** 用户确认保存：将合并后的内容写回磁盘 */
  (e: "save", content: string): void;
  /** 用户放弃本地修改，使用磁盘版本 */
  (e: "use-external", content: string): void;
}>();

/**
 * 可编辑的本地版本（用户可在右侧编辑）
 */
const editableLocal = ref<string>(props.localContent);

// 每次打开时同步最新内容
watch(
  () => props.visible,
  (v) => {
    if (v) {
      editableLocal.value = props.localContent;
    }
  }
);

// 当 localContent 变化时（外部触发重新打开），同步到可编辑副本
watch(
  () => props.localContent,
  (v) => {
    if (props.visible) {
      editableLocal.value = v;
    }
  }
);

// ===== 行级 diff 计算 =====
type DiffOp = "equal" | "external-only" | "local-only" | "modified";

interface DiffRow {
  op: DiffOp;
  externalLine: string | null;
  localLine: string | null;
  /** 行级差异详情（仅 modified 时有值） */
  inner?: Array<{ type: "equal" | "add" | "del"; text: string }>;
}

/**
 * 计算两个文本的行级 diff
 * - equal: 两边相同
 * - external-only: 仅外部版本有（红色）
 * - local-only: 仅本地版本有（绿色）
 * - modified: 两边都有但不同（行内字符级 diff）
 *
 * 实现：将每行编码为单字符（行 → 字符映射），用 diff-match-patch 做行级 diff。
 * 相邻的 del+add 配对合并为 modified 行，行内再做字符级 diff 高亮。
 */
const diffRows = computed<DiffRow[]>(() => {
  const externalLines = props.externalContent.split("\n");
  const localLines = editableLocal.value.split("\n");

  const dmp = new diff_match_patch();
  // 行 → 字符映射，用于将行级 diff 转为字符级 diff 输入
  const lineMap: string[] = [];
  function encodeLines(lines: string[]): string {
    return lines
      .map((line) => {
        const idx = lineMap.indexOf(line);
        if (idx >= 0) return String.fromCharCode(idx + 1);
        lineMap.push(line);
        return String.fromCharCode(lineMap.length);
      })
      .join("");
  }
  const externalEncoded = encodeLines(externalLines);
  const localEncoded = encodeLines(localLines);

  const diffs = dmp.diff_main(externalEncoded, localEncoded);
  dmp.diff_cleanupSemantic(diffs);

  // 转换为 DiffRow：相邻的 del/add 配对合并为 modified
  const rows: DiffRow[] = [];
  let extIdx = 0;
  let locIdx = 0;
  let i = 0;
  while (i < diffs.length) {
    const [op, text] = diffs[i];
    const lineCount = text.length;
    if (op === 0) {
      // equal
      for (let k = 0; k < lineCount; k++) {
        rows.push({
          op: "equal",
          externalLine: externalLines[extIdx] ?? null,
          localLine: localLines[locIdx] ?? null,
        });
        extIdx++;
        locIdx++;
      }
      i++;
    } else if (op === -1) {
      // 检查下一项是否为 add（配对成 modified）
      const next = diffs[i + 1];
      if (next && next[0] === 1) {
        // 取较小行数配对为 modified，多余行作为单独的 del/add
        const delCount = lineCount;
        const addCount = next[1].length;
        const pairCount = Math.min(delCount, addCount);
        for (let k = 0; k < pairCount; k++) {
          const externalText = externalLines[extIdx] ?? "";
          const localText = localLines[locIdx] ?? "";
          rows.push({
            op: "modified",
            externalLine: externalText,
            localLine: localText,
            inner: computeInnerDiff(externalText, localText),
          });
          extIdx++;
          locIdx++;
        }
        // 剩余的 del 行
        for (let k = pairCount; k < delCount; k++) {
          rows.push({
            op: "external-only",
            externalLine: externalLines[extIdx] ?? null,
            localLine: null,
          });
          extIdx++;
        }
        // 剩余的 add 行
        for (let k = pairCount; k < addCount; k++) {
          rows.push({
            op: "local-only",
            externalLine: null,
            localLine: localLines[locIdx] ?? null,
          });
          locIdx++;
        }
        i += 2;
      } else {
        // 仅外部有
        for (let k = 0; k < lineCount; k++) {
          rows.push({
            op: "external-only",
            externalLine: externalLines[extIdx] ?? null,
            localLine: null,
          });
          extIdx++;
        }
        i++;
      }
    } else if (op === 1) {
      // 仅本地有
      for (let k = 0; k < lineCount; k++) {
        rows.push({
          op: "local-only",
          externalLine: null,
          localLine: localLines[locIdx] ?? null,
        });
        locIdx++;
      }
      i++;
    } else {
      i++;
    }
  }

  return rows;
});

/** 计算两个文本行的字符级 diff（用于 modified 行的内联高亮） */
function computeInnerDiff(
  a: string,
  b: string
): Array<{ type: "equal" | "add" | "del"; text: string }> {
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(a, b);
  dmp.diff_cleanupSemantic(diffs);
  return diffs.map(([op, text]) => ({
    type: op === 0 ? "equal" : op === -1 ? "del" : "add",
    text,
  }));
}

// ===== 统计 =====
const stats = computed(() => {
  let added = 0;
  let removed = 0;
  let modified = 0;
  for (const row of diffRows.value) {
    if (row.op === "local-only") added++;
    else if (row.op === "external-only") removed++;
    else if (row.op === "modified") modified++;
  }
  return { added, removed, modified };
});

const hasEdits = computed(() => {
  return editableLocal.value !== props.localContent;
});

// ===== 操作按钮 =====
function onSave(): void {
  emit("save", editableLocal.value);
}

function onUseExternal(): void {
  emit("use-external", props.externalContent);
}

function onClose(): void {
  emit("close");
}

function onLocalInput(e: Event): void {
  const target = e.target as HTMLTextAreaElement;
  editableLocal.value = target.value;
}
</script>

<template>
  <NModal
    :show="visible"
    :mask-closable="false"
    :close-on-esc="false"
    preset="card"
    :title="`对比合并 — ${filePath.split(/[/\\\\]/).pop() ?? filePath}`"
    style="width: 92vw; max-width: 1400px; height: 88vh"
    @update:show="(v: boolean) => !v && onClose()"
  >
    <!-- 顶部工具栏 -->
    <div class="compare-toolbar">
      <NSpace align="center" :size="12">
        <NText depth="3" class="toolbar-label">差异：</NText>
        <NTag size="small" type="success">+{{ stats.added }}</NTag>
        <NTag size="small" type="error">−{{ stats.removed }}</NTag>
        <NTag size="small" type="warning">~{{ stats.modified }}</NTag>
      </NSpace>
      <NSpace align="center" :size="8">
        <NText depth="3" class="legend-text">
          <span class="legend-box legend-equal"></span> 相同
          <span class="legend-box legend-add"></span> 仅本地
          <span class="legend-box legend-del"></span> 仅外部
          <span class="legend-box legend-mod"></span> 修改
        </NText>
      </NSpace>
    </div>

    <!-- 对比区 -->
    <div class="compare-body">
      <!-- 左侧：外部版本（只读） -->
      <div class="compare-side external-side">
        <div class="side-header">
          <span class="side-title">外部版本（磁盘）</span>
          <NText depth="3" class="side-hint">只读</NText>
        </div>
        <NScrollbar class="side-scroll">
          <div class="diff-content">
            <div
              v-for="(row, idx) in diffRows"
              :key="`e-${idx}`"
              class="diff-row"
              :class="`row-${row.op}`"
            >
              <span class="line-no">{{ row.externalLine !== null ? idx + 1 : "" }}</span>
              <span v-if="row.externalLine !== null" class="line-text">
                <template v-if="row.op === 'modified' && row.inner">
                  <span
                    v-for="(seg, sIdx) in row.inner"
                    :key="sIdx"
                    :class="{
                      'seg-del': seg.type === 'del',
                      'seg-add': seg.type === 'add',
                    }"
                  >{{ seg.text }}</span>
                </template>
                <template v-else>{{ row.externalLine }}</template>
              </span>
              <span v-else class="line-text placeholder">—</span>
            </div>
          </div>
        </NScrollbar>
      </div>

      <!-- 右侧：本地版本（可编辑） -->
      <div class="compare-side local-side">
        <div class="side-header">
          <span class="side-title">本地版本（可编辑）</span>
          <NText depth="3" class="side-hint">编辑后点击"保存"写回磁盘</NText>
        </div>
        <textarea
          class="local-editor"
          :value="editableLocal"
          spellcheck="false"
          @input="onLocalInput"
        ></textarea>
      </div>
    </div>

    <!-- 底部操作 -->
    <template #footer>
      <NSpace justify="space-between" align="center">
        <NText v-if="hasEdits" type="warning" class="dirty-hint">
          ⚠ 你已编辑本地版本（与初始内容不同）
        </NText>
        <NText v-else depth="3" class="dirty-hint">
          直接编辑右侧文本框，完成后点击"保存合并结果"
        </NText>
        <NSpace>
          <NButton @click="onClose">取消</NButton>
          <NButton @click="onUseExternal">放弃本地修改</NButton>
          <NButton type="primary" :disabled="!hasEdits" @click="onSave">
            保存合并结果
          </NButton>
        </NSpace>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.compare-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0 12px 0;
  border-bottom: 1px solid #e8e8e8;
  margin-bottom: 12px;
}
.toolbar-label {
  font-size: 12px;
}
.legend-text {
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.legend-box {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  margin: 0 4px 0 8px;
  vertical-align: middle;
}
.legend-equal {
  background: #f0f0f0;
}
.legend-add {
  background: #d4f4dd;
  border: 1px solid #7bd99a;
}
.legend-del {
  background: #ffe0e0;
  border: 1px solid #ff9999;
}
.legend-mod {
  background: #fff3a0;
  border: 1px solid #d4b300;
}

.compare-body {
  display: flex;
  gap: 8px;
  height: calc(100% - 140px);
  min-height: 400px;
}
.compare-side {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid #e0e0e0;
  border-radius: 4px;
  overflow: hidden;
}
.side-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: #fafafa;
  border-bottom: 1px solid #e8e8e8;
  font-size: 12px;
}
.side-title {
  font-weight: 600;
  color: #24292e;
}
.side-hint {
  font-size: 11px;
}
.side-scroll {
  flex: 1;
  min-height: 0;
}
.diff-content {
  font-family: "Consolas", "Menlo", monospace;
  font-size: 12px;
  line-height: 1.5;
  padding: 4px 0;
}
.diff-row {
  display: flex;
  align-items: flex-start;
  padding: 0 8px;
  min-height: 18px;
}
.line-no {
  flex-shrink: 0;
  width: 36px;
  text-align: right;
  color: #999;
  padding-right: 8px;
  user-select: none;
}
.line-text {
  flex: 1;
  white-space: pre-wrap;
  word-break: break-all;
  color: #24292e;
}
.line-text.placeholder {
  color: #ccc;
  font-style: italic;
}
.row-equal {
  background: transparent;
}
.row-external-only {
  background: #ffe0e0;
}
.row-local-only {
  background: #d4f4dd;
}
.row-modified {
  background: #fff3a0;
}

.seg-del {
  background: #ffb3b3;
  text-decoration: line-through;
  color: #c00;
}
.seg-add {
  background: #a5d8a5;
  color: #080;
}

.local-editor {
  flex: 1;
  width: 100%;
  border: none;
  outline: none;
  resize: none;
  padding: 8px 12px;
  font-family: "Consolas", "Menlo", monospace;
  font-size: 12px;
  line-height: 1.5;
  background: #fafafa;
  color: #24292e;
}
.local-editor:focus {
  background: #fff;
}

.dirty-hint {
  font-size: 11px;
  font-style: italic;
}
</style>
