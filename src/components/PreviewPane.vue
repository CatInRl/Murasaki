<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { getMarkdownRenderer, getFrontMatter, setCurrentFilePath } from "../composables/useMarkdownRenderer";
import { renderFrontMatterCard } from "../composables/useFrontMatter";
import { MARKDOWN_THEMES } from "../composables/useTheme";
// 共享 markdown 元素样式（预览/导出统一来源，通过 --md-* 变量参数化主题差异）
import "../styles/markdown-content.css";

interface Props {
  source: string;
  /** 预览主题名（murasaki / github / newsprint / night / academic） */
  theme?: string;
  /** 当前文件路径（用于解析相对 .md 链接） */
  currentFilePath?: string | null;
  /** 工作区根路径（用于解析相对 .md 链接） */
  workspacePath?: string | null;
}

const props = withDefaults(defineProps<Props>(), {
  theme: "murasaki",
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
      theme: "base",
      securityLevel: "loose",
      themeVariables: {
        primaryColor: "#f3e8ff",
        primaryBorderColor: "#9333ea",
        primaryTextColor: "#581c87",
        lineColor: "#9333ea",
        secondaryColor: "#fdf4ff",
        tertiaryColor: "#faf5ff",
        background: "#ffffff",
        mainBkg: "#f3e8ff",
        secondBkg: "#fdf4ff",
        borderColor: "#9333ea",
        edgeLabelBackground: "#faf5ff",
        clusterBkg: "#faf5ff",
        clusterBorder: "#9333ea",
      },
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

// ===== PlantUML（官方 TeaVM 纯浏览器产物，无需服务器）=====
interface PlantUmlApi {
  /** 把 PlantUML 源码行渲染为 SVG 并写入 targetId 元素的 innerHTML */
  render(lines: string[], targetId: string, opts?: { dark?: boolean }): void;
}

let plantUmlReady: Promise<PlantUmlApi> | null = null;

/**
 * 加载 viz-global.js（官方 Viz.js 3.x 全局产物），定义全局 `Viz`，
 * 供 plantuml.js 的 Graphviz/Dot 布局使用。普通 script 一次性注入 + 缓存。
 */
function ensureVizLoaded(): Promise<void> {
  return new Promise((resolve, reject) => {
    const base = import.meta.env.BASE_URL ?? "/";
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-murasaki-plantuml-viz]'
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("加载 viz-global.js 失败")),
        { once: true }
      );
      if ((existing as HTMLScriptElement & { _loaded?: boolean })._loaded) resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = `${base}plantuml/viz-global.js`;
    s.dataset.murasakiPlantumlViz = "1";
    s.onload = () => {
      (s as HTMLScriptElement & { _loaded?: boolean })._loaded = true;
      resolve();
    };
    s.onerror = () => reject(new Error("加载 viz-global.js 失败"));
    document.head.appendChild(s);
  });
}

/** 确保 plantuml.js 已加载（先加载依赖 viz-global.js），返回其模块接口 */
async function ensurePlantUml(): Promise<PlantUmlApi> {
  if (!plantUmlReady) {
    plantUmlReady = (async () => {
      await ensureVizLoaded();
      const base = import.meta.env.BASE_URL ?? "/";
      // 官方产物是独立 ES module，不参与 Vite bundle，运行时动态 import
      const mod = await import(/* @vite-ignore */ `${base}plantuml/plantuml.js`);
      return mod as unknown as PlantUmlApi;
    })();
  }
  return plantUmlReady;
}

async function renderPlantUML(container: HTMLElement) {
  const blocks = container.querySelectorAll<HTMLElement>(".plantuml-block");
  if (blocks.length === 0) return;
  const plantuml = await ensurePlantUml();
  for (const block of Array.from(blocks)) {
    const code = block.textContent || "";
    const id = `plantuml-${Math.random().toString(36).slice(2, 10)}`;
    try {
      block.id = id;
      plantuml.render([code], id, { dark: false });
    } catch (err) {
      block.innerHTML = `<pre style="color:#c00">${(err as Error).message}</pre>`;
    }
  }
}

async function update() {
  const container = containerRef.value;
  if (!container) return;
  // ADR-0015：设置当前文件路径，供 image renderer 解析相对图片路径
  setCurrentFilePath(props.currentFilePath);
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
  // 异步渲染 PlantUML
  await renderPlantUML(container);
}

// 源码变更 → 重新渲染
watch(
  () => props.source,
  () => {
    void nextTick(update);
  },
  { immediate: true }
);

// 当前文件路径变更 → 重新渲染（图片相对路径解析依赖此值）
watch(
  () => props.currentFilePath,
  () => {
    void nextTick(update);
  }
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
  <div ref="scrollRef" class="preview-pane" :data-md-theme="theme">
    <div ref="containerRef" class="markdown-body" @click="onPreviewClick"></div>
  </div>
</template>

<style scoped>
/*
 * 容器布局/滚动条样式保留在此（非 markdown 元素样式）。
 * 所有 markdown 元素样式与主题变量统一在 src/styles/markdown-content.css，
 * 通过 .preview-pane 上的 data-md-theme 属性驱动 --md-* 变量切换。
 */
.preview-pane {
  height: 100%;
  width: 100%;
  overflow: auto;
  padding: 28px 36px;
  background: var(--md-bg, var(--murasaki-background));
  color: var(--md-fg, var(--murasaki-ink));
  font-family: var(--murasaki-font-reading, var(--murasaki-font-ui));
  font-size: 14px;
  line-height: 1.75;
  transition: padding var(--murasaki-duration-base) var(--murasaki-ease);
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

/* === 紧凑窗口：减小 padding === */
@media (max-width: 980px) {
  .preview-pane {
    padding: 20px 24px;
    font-size: 13px;
  }
}
</style>
