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
  padding: 24px 32px;
  background: #fff;
  color: #24292e;
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

.markdown-body :deep(h1) { font-size: 2em; margin: 0.67em 0; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
.markdown-body :deep(h2) { font-size: 1.5em; margin: 0.83em 0; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
.markdown-body :deep(h3) { font-size: 1.25em; margin: 1em 0; }
.markdown-body :deep(h4) { font-size: 1em; margin: 1em 0; }
.markdown-body :deep(h5) { font-size: 0.875em; margin: 1em 0; }
.markdown-body :deep(h6) { font-size: 0.85em; color: #6a737d; margin: 1em 0; }
.markdown-body :deep(p) { margin: 0 0 16px; line-height: 1.6; }
.markdown-body :deep(ul), .markdown-body :deep(ol) { margin: 0 0 16px; padding-left: 2em; }
.markdown-body :deep(li) { margin: 4px 0; }
.markdown-body :deep(blockquote) {
  margin: 0 0 16px;
  padding: 0 1em;
  color: #6a737d;
  border-left: 0.25em solid #dfe2e5;
}
.markdown-body :deep(code) {
  font-family: Consolas, 'Courier New', monospace;
  font-size: 0.92em;
  background: rgba(175, 184, 193, 0.2);
  padding: 0.2em 0.4em;
  border-radius: 3px;
}
.markdown-body :deep(pre) {
  background: #0d1117;
  color: #c9d1d9;
  padding: 16px;
  border-radius: 6px;
  overflow: auto;
  margin: 0 0 16px;
}
.markdown-body :deep(pre code) {
  background: transparent;
  padding: 0;
  font-size: 0.9em;
}
.markdown-body :deep(a) { color: #0366d6; text-decoration: none; }
.markdown-body :deep(a:hover) { text-decoration: underline; }
.markdown-body :deep(img) { max-width: 100%; }
.markdown-body :deep(table) {
  border-collapse: collapse;
  margin: 0 0 16px;
  display: block;
  overflow: auto;
}
.markdown-body :deep(th), .markdown-body :deep(td) {
  border: 1px solid #dfe2e5;
  padding: 6px 13px;
}
.markdown-body :deep(th) { background: #f6f8fa; font-weight: 600; }
.markdown-body :deep(hr) { border: 0; border-top: 1px solid #eaecef; margin: 24px 0; }
.markdown-body :deep(.mermaid) { text-align: center; margin: 16px 0; }
.markdown-body :deep(input[type="checkbox"]) { margin-right: 0.5em; }

.theme-night .markdown-body :deep(a) { color: #58a6ff; }
.theme-night .markdown-body :deep(blockquote) { color: #8b949e; border-left-color: #30363d; }
.theme-night .markdown-body :deep(th) { background: #161b22; }
.theme-night .markdown-body :deep(th), .theme-night .markdown-body :deep(td) { border-color: #30363d; }
.theme-night .markdown-body :deep(code) { background: rgba(110, 118, 129, 0.4); }

/* ===== Front-matter 卡片样式 ===== */
.markdown-body :deep(.front-matter-card) {
  background: #f6f8fa;
  border: 1px solid #eaecef;
  border-radius: 6px;
  padding: 12px 16px;
  margin: 0 0 24px;
  font-size: 13px;
}
.markdown-body :deep(.front-matter-card .fm-title) {
  font-size: 18px;
  font-weight: 700;
  color: #24292e;
  margin-bottom: 8px;
  line-height: 1.4;
}
.markdown-body :deep(.front-matter-card .fm-row) {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 4px 0;
  color: #555;
}
.markdown-body :deep(.front-matter-card .fm-key) {
  font-weight: 600;
  color: #6a737d;
  min-width: 60px;
  text-transform: capitalize;
}
.markdown-body :deep(.front-matter-card .fm-value) {
  color: #24292e;
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
  background: #0366d6;
  color: #fff;
  padding: 2px 10px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.3px;
}

/* Night 主题下 front-matter 卡片配色 */
.theme-night .markdown-body :deep(.front-matter-card) {
  background: #161b22;
  border-color: #30363d;
}
.theme-night .markdown-body :deep(.front-matter-card .fm-title) {
  color: #c9d1d9;
}
.theme-night .markdown-body :deep(.front-matter-card .fm-key) {
  color: #8b949e;
}
.theme-night .markdown-body :deep(.front-matter-card .fm-value) {
  color: #c9d1d9;
}
.theme-night .markdown-body :deep(.front-matter-card .fm-tag) {
  background: #1f6feb;
}
</style>
