<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import type { EditorView } from "@codemirror/view";
import { NPopover, NInput, NButton, NInputNumber, NSpace } from "naive-ui";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Link as LinkIcon,
  Image as ImageIcon,
  Table as TableIcon,
  Minus,
  Code2,
} from "lucide-vue-next";
import {
  toggleInline,
  setHeading,
  toggleList,
  toggleBlockquote,
  toggleCodeBlock,
  insertHorizontalRule,
  insertTable,
  insertLink,
  insertImage,
  getActiveFormats,
} from "../composables/useEditorCommands";

/**
 * 编辑器顶部工具栏（源码/WYSIWYG 双模式共用）。
 *
 * 所有按钮行为都是修改底层 markdown 文本（通过 CodeMirror EditorView dispatch），
 * 不依赖 WYSIWYG 装饰层。插入类按钮（链接/图片/表格）点击弹出 NPopover 浮层表单。
 */

interface Props {
  /** 获取 CodeMirror EditorView 的函数（惰性求值，工具栏操作时调用） */
  getView: () => EditorView | null;
  /** 光标变化信号（每次光标移动递增，触发激活态刷新） */
  cursorKey?: number;
}

const props = withDefaults(defineProps<Props>(), {
  cursorKey: 0,
});

// ============ 激活态 ============
const activeFormats = ref<Set<string>>(new Set());

function refreshActive(): void {
  const view = props.getView();
  if (!view) {
    activeFormats.value = new Set();
    return;
  }
  activeFormats.value = getActiveFormats(view);
}

refreshActive();
onMounted(refreshActive);
watch(() => props.cursorKey, refreshActive);

// ============ 内联格式化按钮 ============
interface FormatButton {
  id: string;
  icon: typeof Bold;
  title: string;
  marker?: string; // toggleInline marker
  action?: "code-block" | "hr";
  headingLevel?: number;
  listType?: "unordered" | "ordered" | "task";
  blockquote?: boolean;
}

const textButtons: FormatButton[] = [
  { id: "bold", icon: Bold, title: "加粗", marker: "**" },
  { id: "italic", icon: Italic, title: "斜体", marker: "*" },
  { id: "strikethrough", icon: Strikethrough, title: "删除线", marker: "~~" },
  { id: "code", icon: Code, title: "行内代码", marker: "`" },
];

const headingButtons: FormatButton[] = [
  { id: "h1", icon: Heading1, title: "标题 1", headingLevel: 1 },
  { id: "h2", icon: Heading2, title: "标题 2", headingLevel: 2 },
  { id: "h3", icon: Heading3, title: "标题 3", headingLevel: 3 },
];

const listButtons: FormatButton[] = [
  { id: "unordered-list", icon: List, title: "无序列表", listType: "unordered" },
  { id: "ordered-list", icon: ListOrdered, title: "有序列表", listType: "ordered" },
  { id: "task-list", icon: ListChecks, title: "任务列表", listType: "task" },
  { id: "blockquote", icon: Quote, title: "引用", blockquote: true },
];

const insertButtons: FormatButton[] = [
  { id: "code-block", icon: Code2, title: "代码块", action: "code-block" },
  { id: "hr", icon: Minus, title: "水平分隔线", action: "hr" },
];

function onFormatClick(btn: FormatButton): void {
  const view = props.getView();
  if (!view) return;
  view.focus();
  if (btn.marker) {
    toggleInline(view, btn.marker);
  } else if (btn.headingLevel !== undefined) {
    // 同级标题再次点击 → 取消（level 0）
    const level = activeFormats.value.has(btn.id) ? 0 : btn.headingLevel;
    setHeading(view, level);
  } else if (btn.listType) {
    toggleList(view, btn.listType);
  } else if (btn.blockquote) {
    toggleBlockquote(view);
  } else if (btn.action === "code-block") {
    toggleCodeBlock(view);
  } else if (btn.action === "hr") {
    insertHorizontalRule(view);
  }
  refreshActive();
}

// ============ 链接/图片/表格浮层表单 ============
const linkPopoverShow = ref(false);
const linkUrl = ref("");
const linkText = ref("");

const imagePopoverShow = ref(false);
const imageUrl = ref("");
const imageAlt = ref("");

const tablePopoverShow = ref(false);
const tableRows = ref(2);
const tableCols = ref(3);

function openLinkPopover(): void {
  // 选区文字作为默认链接文字
  const view = props.getView();
  if (view) {
    const { from, to } = view.state.selection.main;
    linkText.value = from !== to ? view.state.doc.sliceString(from, to) : "";
  }
  linkUrl.value = "";
  linkPopoverShow.value = true;
}

function confirmLink(): void {
  const view = props.getView();
  if (!view || !linkUrl.value.trim()) {
    linkPopoverShow.value = false;
    return;
  }
  view.focus();
  insertLink(view, linkUrl.value.trim(), linkText.value);
  linkPopoverShow.value = false;
}

function openImagePopover(): void {
  const view = props.getView();
  if (view) {
    const { from, to } = view.state.selection.main;
    imageAlt.value = from !== to ? view.state.doc.sliceString(from, to) : "";
  }
  imageUrl.value = "";
  imagePopoverShow.value = true;
}

function confirmImage(): void {
  const view = props.getView();
  if (!view || !imageUrl.value.trim()) {
    imagePopoverShow.value = false;
    return;
  }
  view.focus();
  insertImage(view, imageUrl.value.trim(), imageAlt.value);
  imagePopoverShow.value = false;
}

function openTablePopover(): void {
  tableRows.value = 2;
  tableCols.value = 3;
  tablePopoverShow.value = true;
}

function confirmTable(): void {
  const view = props.getView();
  if (!view) {
    tablePopoverShow.value = false;
    return;
  }
  view.focus();
  const r = Math.max(1, Math.min(50, tableRows.value));
  const c = Math.max(1, Math.min(20, tableCols.value));
  insertTable(view, r, c);
  tablePopoverShow.value = false;
}
</script>

<template>
  <div class="editor-toolbar" role="toolbar" aria-label="格式化工具栏">
    <!-- 文本格式 -->
    <button
      v-for="btn in textButtons"
      :key="btn.id"
      type="button"
      :title="btn.title"
      :aria-pressed="activeFormats.has(btn.id)"
      class="tb-btn"
      :class="{ active: activeFormats.has(btn.id) }"
      @click="onFormatClick(btn)"
    >
      <component :is="btn.icon" class="tb-icon" />
    </button>

    <span class="tb-sep" aria-hidden="true"></span>

    <!-- 标题 -->
    <button
      v-for="btn in headingButtons"
      :key="btn.id"
      type="button"
      :title="btn.title"
      :aria-pressed="activeFormats.has(btn.id)"
      class="tb-btn"
      :class="{ active: activeFormats.has(btn.id) }"
      @click="onFormatClick(btn)"
    >
      <component :is="btn.icon" class="tb-icon" />
    </button>

    <span class="tb-sep" aria-hidden="true"></span>

    <!-- 列表/引用 -->
    <button
      v-for="btn in listButtons"
      :key="btn.id"
      type="button"
      :title="btn.title"
      :aria-pressed="activeFormats.has(btn.id)"
      class="tb-btn"
      :class="{ active: activeFormats.has(btn.id) }"
      @click="onFormatClick(btn)"
    >
      <component :is="btn.icon" class="tb-icon" />
    </button>

    <span class="tb-sep" aria-hidden="true"></span>

    <!-- 插入：链接/图片/表格（NPopover 浮层） -->
    <NPopover
      v-model:show="linkPopoverShow"
      trigger="click"
      placement="bottom-start"
      :show-arrow="false"
      @update:show="(s: boolean) => s && openLinkPopover()"
    >
      <template #trigger>
        <button type="button" title="插入链接" class="tb-btn">
          <LinkIcon class="tb-icon" />
        </button>
      </template>
      <div class="pop-form">
        <label class="pop-label">链接地址</label>
        <NInput
          v-model:value="linkUrl"
          size="small"
          placeholder="https://..."
          class="pop-input"
        />
        <label class="pop-label">链接文字</label>
        <NInput
          v-model:value="linkText"
          size="small"
          placeholder="链接文字（可选）"
          class="pop-input"
        />
        <NSpace justify="end" class="pop-actions">
          <NButton size="small" @click="linkPopoverShow = false">取消</NButton>
          <NButton size="small" type="primary" @click="confirmLink">确认</NButton>
        </NSpace>
      </div>
    </NPopover>

    <NPopover
      v-model:show="imagePopoverShow"
      trigger="click"
      placement="bottom-start"
      :show-arrow="false"
      @update:show="(s: boolean) => s && openImagePopover()"
    >
      <template #trigger>
        <button type="button" title="插入图片" class="tb-btn">
          <ImageIcon class="tb-icon" />
        </button>
      </template>
      <div class="pop-form">
        <label class="pop-label">图片路径</label>
        <NInput
          v-model:value="imageUrl"
          size="small"
          placeholder="/assets/figure.png"
          class="pop-input"
        />
        <label class="pop-label">替代文字</label>
        <NInput
          v-model:value="imageAlt"
          size="small"
          placeholder="替代文字（可选）"
          class="pop-input"
        />
        <NSpace justify="end" class="pop-actions">
          <NButton size="small" @click="imagePopoverShow = false">取消</NButton>
          <NButton size="small" type="primary" @click="confirmImage">插入</NButton>
        </NSpace>
      </div>
    </NPopover>

    <NPopover
      v-model:show="tablePopoverShow"
      trigger="click"
      placement="bottom-start"
      :show-arrow="false"
      @update:show="(s: boolean) => s && openTablePopover()"
    >
      <template #trigger>
        <button type="button" title="插入表格" class="tb-btn">
          <TableIcon class="tb-icon" />
        </button>
      </template>
      <div class="pop-form">
        <div class="pop-row">
          <div class="pop-col">
            <label class="pop-label">行数</label>
            <NInputNumber v-model:value="tableRows" :min="1" :max="50" size="small" />
          </div>
          <div class="pop-col">
            <label class="pop-label">列数</label>
            <NInputNumber v-model:value="tableCols" :min="1" :max="20" size="small" />
          </div>
        </div>
        <NSpace justify="end" class="pop-actions">
          <NButton size="small" @click="tablePopoverShow = false">取消</NButton>
          <NButton size="small" type="primary" @click="confirmTable">插入</NButton>
        </NSpace>
      </div>
    </NPopover>

    <span class="tb-sep" aria-hidden="true"></span>

    <!-- 代码块 / 水平线 -->
    <button
      v-for="btn in insertButtons"
      :key="btn.id"
      type="button"
      :title="btn.title"
      class="tb-btn"
      @click="onFormatClick(btn)"
    >
      <component :is="btn.icon" class="tb-icon" />
    </button>
  </div>
</template>

<style scoped>
.editor-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  padding: 6px 8px;
  background: var(--murasaki-surface);
  border-bottom: 1px solid var(--murasaki-border);
  flex-shrink: 0;
}

.tb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 6px;
  border: none;
  border-radius: var(--murasaki-radius-md);
  background: transparent;
  color: var(--murasaki-muted-foreground);
  cursor: pointer;
  transition: background-color var(--murasaki-duration-fast, 120ms) ease,
              color var(--murasaki-duration-fast, 120ms) ease;
}

.tb-btn:hover {
  background: var(--murasaki-muted);
  color: var(--murasaki-foreground);
}

.tb-btn:focus-visible {
  outline: 2px solid var(--murasaki-ring);
  outline-offset: 1px;
}

.tb-btn.active {
  background: rgba(147, 51, 234, 0.1);
  color: var(--murasaki-primary);
}

.tb-btn.active:hover {
  background: rgba(147, 51, 234, 0.16);
  color: var(--murasaki-primary);
}

.tb-icon {
  width: 16px;
  height: 16px;
}

.tb-sep {
  display: inline-block;
  width: 1px;
  height: 20px;
  background: var(--murasaki-border);
  margin: 0 4px;
  flex-shrink: 0;
}

/* 浮层表单 */
.pop-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 240px;
}

.pop-row {
  display: flex;
  gap: 12px;
}

.pop-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pop-label {
  font-size: 12px;
  color: var(--murasaki-muted-foreground);
}

.pop-input {
  width: 100%;
}

.pop-actions {
  margin-top: 4px;
}
</style>
