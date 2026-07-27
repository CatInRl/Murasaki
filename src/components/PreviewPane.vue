<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { getMarkdownRenderer, getFrontMatter } from "../composables/useMarkdownRenderer";
import { renderFrontMatterCard } from "../composables/useFrontMatter";
import { MARKDOWN_THEMES } from "../composables/useTheme";

interface Props {
  source: string;
  /** 主题样式类名（github / newsprint / night / academic） */
  theme?: string;
  /** 当前文件路径（用于解析相对 .md 链接） */
  currentFilePath?: string | null;
  /** 工作区根路径（用于解析相对 .md 链接） */
  workspacePath?: string | null;
}

const props = withDefaults(defineProps<Props>(), {
  theme: "github",
  currentFilePath: null,
  workspacePath: null,
});

const containerRef = ref<HTMLDivElement | null>(null);
// 滚动容器：.preview-pane 本身（overflow: auto）
const scrollRef = ref<HTMLDivElement | null>(null);
const renderer = getMarkdownRenderer();

const emit = defineEmits<{
  (e: "task-toggle", payload: { li: HTMLElement; checked: boolean }): void;
  /** 内部 .md 链接点击：要求父组件在新 tab 中打开 */
  (e: "open-internal", path: string): void;
}>();

/** 根据 Markdown 主题名查找对应的 Shiki 主题 */
function resolveShikiTheme(themeName: string): string {
  return (
    MARKDOWN_THEMES.find((t) => t.name === themeName)?.shikiTheme ??
    "github-light"
  );
}

// 初始化 Shiki 主题（与 props.theme 同步，确保首次渲染就用对的主题）
renderer.setShikiTheme(resolveShikiTheme(props.theme));

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, code: string): Promise<{ svg: string }>;
}

let mermaidReady: MermaidApi | null = null;

async function ensureMermaid(): Promise<MermaidApi> {
  if (!mermaidReady) {
    const mod = await import("mermaid");
    const mermaid = (mod.default ?? mod) as unknown as MermaidApi;
    mermaid.initialize({
      startOnLoad: false,
      theme: "default",
      securityLevel: "loose",
    });
    mermaidReady = mermaid;
  }
  return mermaidReady;
}

async function renderMermaid(container: HTMLElement) {
  const blocks = container.querySelectorAll<HTMLElement>(".mermaid");
  if (blocks.length === 0) return;
  const mermaid = await ensureMermaid();
  for (const block of Array.from(blocks)) {
    const code = block.textContent || "";
    const id = `mermaid-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const { svg } = await mermaid.render(id, code);
      block.innerHTML = svg;
    } catch (err) {
      block.innerHTML = `<pre style="color:#c00">${(err as Error).message}</pre>`;
    }
  }
}

async function update() {
  const container = containerRef.value;
  if (!container) return;
  // 同步渲染 HTML
  const bodyHtml = renderer.render(props.source);
  // 渲染 front-matter 卡片（spec：YAML frontmatter 必须解析并渲染为样式化卡片）
  // 共享实现：PreviewPane 与 useHtmlExport 必须使用同一渲染函数
  const fmCard = renderFrontMatterCard(getFrontMatter());
  container.innerHTML = fmCard + bodyHtml;
  // 异步高亮代码块
  await renderer.highlight(container);
  // 异步渲染 Mermaid
  await renderMermaid(container);
}

// 源码变更 → 重新渲染
watch(
  () => props.source,
  () => {
    void nextTick(update);
  },
  { immediate: true }
);

// 主题变更 → 切换 Shiki 主题并重新渲染（代码块高亮跟随主题）
watch(
  () => props.theme,
  (newTheme) => {
    renderer.setShikiTheme(resolveShikiTheme(newTheme));
    void nextTick(update);
  }
);

onBeforeUnmount(() => {
  containerRef.value = null;
});

// ===== 链接点击处理 =====
// spec：预览区内链接点击
//  - 相对路径指向工作区内 .md 文件 → 在新 tab 打开
//  - 外部 URL（http/https/ftp 等）→ 系统浏览器打开
//  - 锚点链接（#section）→ 滚动到对应标题
//  - 其他类型（mailto、tel 等）→ 默认行为
const MD_EXTENSIONS = ["md", "markdown", "mdown", "mkd"];

function isExternalUrl(href: string): boolean {
  return /^(https?:|ftp:|file:|mailto:|tel:)/i.test(href);
}

function isAnchorLink(href: string): boolean {
  return href.startsWith("#");
}

/**
 * 解析相对 .md 链接为绝对路径
 *  - 若 currentFilePath 存在：以该文件所在目录为基准
 *  - 否则以 workspacePath 为基准
 *  - 若解析后是 .md 文件则返回绝对路径，否则返回 null
 */
function resolveInternalMd(href: string): string | null {
  if (isExternalUrl(href) || isAnchorLink(href)) return null;

  // 去掉 URL fragment 和 query
  const cleanHref = href.split("#")[0].split("?")[0];
  if (!cleanHref) return null;

  // 检查扩展名
  const ext = cleanHref.split(".").pop()?.toLowerCase() ?? "";
  if (!MD_EXTENSIONS.includes(ext)) return null;

  // 解析为绝对路径
  let basePath: string | null = null;
  if (props.currentFilePath) {
    // 以当前文件所在目录为基准
    const norm = props.currentFilePath.replace(/\\/g, "/");
    basePath = norm.split("/").slice(0, -1).join("/");
  } else if (props.workspacePath) {
    basePath = props.workspacePath.replace(/\\/g, "/").replace(/\/$/, "");
  }
  if (!basePath) return null;

  // 处理相对路径（../, ./）
  const baseParts = basePath.split("/").filter(Boolean);
  const hrefParts = cleanHref.replace(/\\/g, "/").split("/").filter(Boolean);
  for (const part of hrefParts) {
    if (part === ".") continue;
    if (part === "..") {
      baseParts.pop();
    } else {
      baseParts.push(part);
    }
  }
  // 重新加上盘符前缀（Windows）
  const isAbsolute = /^([a-zA-Z]:)?\//.test(props.currentFilePath ?? props.workspacePath ?? "");
  const absolutePath = isAbsolute ? "/" + baseParts.join("/") : baseParts.join("/");
  return absolutePath;
}

/**
 * 滚动预览到指定锚点（heading id）
 * markdown-it 默认会为标题生成 id（基于文本 slugify）
 */
function scrollToAnchor(anchor: string): void {
  const container = containerRef.value;
  if (!container) return;
  const id = anchor.slice(1); // 去掉 #
  const target = container.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  if (target) {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

/**
 * 链接点击统一处理
 */
async function handleLinkClick(e: MouseEvent): Promise<void> {
  const target = e.target as HTMLElement;
  const anchor = target.closest("a") as HTMLAnchorElement | null;
  if (!anchor) return;

  const href = anchor.getAttribute("href") ?? "";
  if (!href) return;

  // 锚点链接：滚动到对应标题
  if (isAnchorLink(href)) {
    e.preventDefault();
    scrollToAnchor(href);
    return;
  }

  // 外部 URL：用系统浏览器打开
  if (isExternalUrl(href)) {
    e.preventDefault();
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(href);
    } catch (err) {
      console.error("打开外部链接失败:", err);
      // 失败时回退到默认行为
      window.open(href, "_blank");
    }
    return;
  }

  // 内部 .md 链接：在新 tab 中打开
  const mdPath = resolveInternalMd(href);
  if (mdPath) {
    e.preventDefault();
    emit("open-internal", mdPath);
    return;
  }

  // 其他类型：默认行为
}

// 任务列表复选框点击：切换 [ ] ↔ [x]
function handleTaskToggle(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (target.tagName === "INPUT" && target.getAttribute("type") === "checkbox") {
    const li = target.closest("li");
    if (!li) return;
    // task-lists 默认输出：input 紧跟在 li 内部
    const checked = (target as HTMLInputElement).checked;
    // 通过自定义事件把改动上报父组件
    emit("task-toggle", { li, checked });
  }
}

/**
 * 预览区点击统一处理：
 * - 先尝试链接点击
 * - 再尝试任务列表切换
 * - 其他点击不做处理（spec：预览区禁止一般性点击交互）
 */
function onPreviewClick(e: MouseEvent): void {
  // 任务列表 checkbox 优先
  const target = e.target as HTMLElement;
  if (target.tagName === "INPUT" && target.getAttribute("type") === "checkbox") {
    handleTaskToggle(e);
    return;
  }
  // 链接点击
  void handleLinkClick(e);
}

defineExpose({
  /** 返回预览区的滚动容器，供滚动同步使用 */
  getScrollDom: (): HTMLElement | null => scrollRef.value,
  /** 返回渲染内容的容器（含 data-source-line 元素） */
  getContentContainer: (): HTMLElement | null => containerRef.value,
});</script>

<template>
  <div ref="scrollRef" class="preview-pane" :class="`theme-${theme}`">
    <div ref="containerRef" class="markdown-body" @click="onPreviewClick"></div>
  </div>
</template>

<style scoped>
.preview-pane {
  height: 100%;
  width: 100%;
  overflow: auto;
  padding: 28px 36px;
  background: var(--murasaki-background);
  color: var(--murasaki-ink);
  font-family: var(--murasaki-font-ui);
  font-size: 14px;
  line-height: 1.75;
  transition: padding var(--murasaki-duration-base) var(--murasaki-ease);
}
.preview-pane.theme-night {
  background: #0d1117;
  color: #c9d1d9;
}
.preview-pane.theme-newsprint {
  background: #f5f5f0;
  color: #2a2a2a;
}
.preview-pane.theme-academic {
  background: #fffdf7;
  color: #1a1a1a;
}

/* 滚动条样式（继承自全局） */
.preview-pane::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
.preview-pane::-webkit-scrollbar-thumb {
  background: var(--murasaki-neutral-300);
  border-radius: 5px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
.preview-pane::-webkit-scrollbar-thumb:hover {
  background: var(--murasaki-neutral-400);
  background-clip: padding-box;
}

/* === Typography (refined for purple brand) === */
.markdown-body :deep(h1) {
  font-size: 26px;
  font-weight: 700;
  margin: 0 0 16px 0;
  letter-spacing: -0.02em;
  line-height: 1.3;
  color: var(--murasaki-ink);
}
.markdown-body :deep(h2) {
  font-size: 20px;
  font-weight: 600;
  margin: 20px 0 10px 0;
  letter-spacing: -0.01em;
  line-height: 1.35;
  color: var(--murasaki-ink);
}
.markdown-body :deep(h3) {
  font-size: 17px;
  font-weight: 600;
  margin: 16px 0 8px 0;
  color: var(--murasaki-ink);
}
.markdown-body :deep(h4) {
  font-size: 15px;
  font-weight: 600;
  margin: 14px 0 6px 0;
  color: var(--murasaki-ink);
}
.markdown-body :deep(h5) {
  font-size: 14px;
  font-weight: 600;
  margin: 12px 0 4px 0;
  color: var(--murasaki-ink-2);
}
.markdown-body :deep(h6) {
  font-size: 13px;
  font-weight: 600;
  margin: 12px 0 4px 0;
  color: var(--murasaki-ink-3);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.markdown-body :deep(p) {
  margin: 0 0 12px 0;
  line-height: 1.75;
  color: var(--murasaki-ink-2);
}
.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 0 0 12px 0;
  padding-left: 24px;
}
.markdown-body :deep(li) {
  margin: 4px 0;
  color: var(--murasaki-ink-2);
}
.markdown-body :deep(li::marker) {
  color: var(--murasaki-primary);
}
/* Task list: 移除默认 list-style，让 checkbox 居首 */
.markdown-body :deep(.task-list-item) {
  list-style: none;
  margin-left: -20px;
}
.markdown-body :deep(input[type="checkbox"]) {
  margin-right: 8px;
  width: 14px;
  height: 14px;
  accent-color: var(--murasaki-primary);
  vertical-align: middle;
  cursor: pointer;
}

/* Blockquote: purple left border + purple-50 bg */
.markdown-body :deep(blockquote) {
  margin: 12px 0;
  padding: 10px 16px;
  border-left: 3px solid var(--murasaki-primary);
  background: var(--murasaki-purple-50);
  border-radius: 0 var(--murasaki-radius-sm) var(--murasaki-radius-sm) 0;
  color: var(--murasaki-ink-2);
}
.markdown-body :deep(blockquote p) {
  margin: 0;
}

/* Inline code: purple-tinted */
.markdown-body :deep(code) {
  font-family: var(--murasaki-font-mono);
  font-size: 0.88em;
  background: rgba(147, 51, 234, 0.08);
  color: var(--murasaki-purple-800);
  padding: 0.15em 0.4em;
  border-radius: 3px;
}

/* Code block: dark surface */
.markdown-body :deep(pre) {
  background: var(--murasaki-neutral-900);
  color: #e5e7eb;
  padding: 14px 18px;
  border-radius: var(--murasaki-radius-md);
  overflow: auto;
  margin: 12px 0 16px 0;
  font-size: 13px;
  line-height: 1.6;
  box-shadow: var(--murasaki-shadow-sm);
}
.markdown-body :deep(pre code) {
  background: transparent;
  color: inherit;
  padding: 0;
  font-size: 13px;
  border-radius: 0;
}

/* Links: purple, hover underline */
.markdown-body :deep(a) {
  color: var(--murasaki-purple-700);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: border-color var(--murasaki-duration-fast) var(--murasaki-ease),
              color var(--murasaki-duration-fast) var(--murasaki-ease);
}
.markdown-body :deep(a:hover) {
  border-bottom-color: currentColor;
}

.markdown-body :deep(img) {
  max-width: 100%;
  border-radius: var(--murasaki-radius-sm);
  box-shadow: var(--murasaki-shadow-sm);
}

/* Tables */
.markdown-body :deep(table) {
  border-collapse: collapse;
  margin: 0 0 16px;
  display: block;
  overflow: auto;
  font-size: 13px;
  width: max-content;
  max-width: 100%;
}
.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--murasaki-line);
  padding: 8px 14px;
}
.markdown-body :deep(th) {
  background: var(--murasaki-surface-2);
  font-weight: 600;
  color: var(--murasaki-ink);
  text-align: left;
}
.markdown-body :deep(td) {
  color: var(--murasaki-ink-2);
}
.markdown-body :deep(tr:hover td) {
  background: var(--murasaki-purple-50);
}

.markdown-body :deep(hr) {
  border: 0;
  border-top: 1px solid var(--murasaki-line);
  margin: 24px 0;
}
.markdown-body :deep(.mermaid) {
  text-align: center;
  margin: 16px 0;
}

/* === Theme-specific overrides === */
.theme-night .markdown-body :deep(a) { color: #a78bfa; }
.theme-night .markdown-body :deep(blockquote) {
  color: #b3b3c0;
  border-left-color: #7e22ce;
  background: rgba(126, 34, 206, 0.12);
}
.theme-night .markdown-body :deep(th) { background: #161b22; }
.theme-night .markdown-body :deep(th),
.theme-night .markdown-body :deep(td) { border-color: #30363d; }
.theme-night .markdown-body :deep(code) {
  background: rgba(110, 118, 129, 0.4);
  color: #d8b4fe;
}
.theme-night .markdown-body :deep(tr:hover td) {
  background: rgba(126, 34, 206, 0.12);
}

.theme-newsprint .markdown-body :deep(a) { color: #5b21b6; }
.theme-newsprint .markdown-body :deep(blockquote) {
  border-left-color: #5b21b6;
  background: #ede9d8;
}

.theme-academic .markdown-body :deep(a) { color: #6b21a8; }
.theme-academic .markdown-body :deep(blockquote) {
  border-left-color: #6b21a8;
  background: #f5edd6;
}

/* ===== Front-matter 卡片样式 ===== */
.markdown-body :deep(.front-matter-card) {
  background: linear-gradient(135deg, var(--murasaki-purple-50) 0%, var(--murasaki-surface-2) 100%);
  border: 1px solid var(--murasaki-purple-200);
  border-radius: var(--murasaki-radius-md);
  padding: 14px 18px;
  margin: 0 0 24px;
  font-size: 13px;
  position: relative;
  overflow: hidden;
}
.markdown-body :deep(.front-matter-card)::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 3px;
  height: 100%;
  background: var(--murasaki-primary);
}
.markdown-body :deep(.front-matter-card .fm-title) {
  font-size: 18px;
  font-weight: 700;
  color: var(--murasaki-purple-800);
  margin-bottom: 8px;
  line-height: 1.4;
}
.markdown-body :deep(.front-matter-card .fm-row) {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 4px 0;
  color: var(--murasaki-ink-2);
}
.markdown-body :deep(.front-matter-card .fm-key) {
  font-weight: 600;
  color: var(--murasaki-purple-700);
  min-width: 60px;
  text-transform: capitalize;
}
.markdown-body :deep(.front-matter-card .fm-value) {
  color: var(--murasaki-ink);
}
.markdown-body :deep(.front-matter-card .fm-date) {
  font-variant-numeric: tabular-nums;
}
.markdown-body :deep(.front-matter-card .fm-tags) {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.markdown-body :deep(.front-matter-card .fm-tag) {
  display: inline-block;
  background: var(--murasaki-primary);
  color: #fff;
  padding: 2px 10px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.3px;
}

/* Night 主题下 front-matter 卡片配色 */
.theme-night .markdown-body :deep(.front-matter-card) {
  background: linear-gradient(135deg, rgba(126, 34, 206, 0.15) 0%, #161b22 100%);
  border-color: #7e22ce;
}
.theme-night .markdown-body :deep(.front-matter-card .fm-title) {
  color: #d8b4fe;
}
.theme-night .markdown-body :deep(.front-matter-card .fm-key) {
  color: #c084fc;
}
.theme-night .markdown-body :deep(.front-matter-card .fm-value) {
  color: #e5e7eb;
}
.theme-night .markdown-body :deep(.front-matter-card .fm-tag) {
  background: #7e22ce;
}

/* === 紧凑窗口：减小 padding === */
@media (max-width: 980px) {
  .preview-pane {
    padding: 20px 24px;
    font-size: 13px;
  }
  .markdown-body :deep(h1) { font-size: 22px; }
  .markdown-body :deep(h2) { font-size: 18px; }
}

/* === 触屏：增加点击区 === */
@media (pointer: coarse) {
  .markdown-body :deep(a) {
    padding: 2px 0;
  }
  .markdown-body :deep(input[type="checkbox"]) {
    width: 18px;
    height: 18px;
  }
}
</style>
