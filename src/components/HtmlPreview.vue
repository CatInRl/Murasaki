<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

interface Props {
  /** 原始 HTML 内容 */
  source?: string;
}

withDefaults(defineProps<Props>(), {
  source: "",
});

const emit = defineEmits<{
  /** 子文档内的滚轮事件（iframe 会吞掉滚轮，父文档收不到，见下方 attachFrameListeners） */
  (e: "inner-wheel", ev: WheelEvent): void;
  /** 子文档内的键盘事件（同上，焦点在 iframe 内时父 window 收不到 keydown） */
  (e: "inner-keydown", ev: KeyboardEvent): void;
}>();

const scrollRef = ref<HTMLDivElement | null>(null);
const frameRef = ref<HTMLIFrameElement | null>(null);

/** 幂等标记：写在子文档 documentElement 的 dataset 上，随文档对象走 */
const ATTACH_FLAG = "murasakiEventsAttached";
const ATTACH_POLL_MS = 100;

/**
 * 把子文档里的滚轮 / 键盘事件抛回父组件（issue #405）。
 *
 * 滚轮与键盘事件都发生在 iframe 的子文档里，不会跨越 iframe 边界冒泡到父文档：
 * 演示模式的 Ctrl+滚轮挂在 `.preview-zoom` 上、全局快捷键挂在父 `window` 上，
 * 两条入口对 HTML 预览全部失效（实测：iframe 上方 Ctrl+滚轮父文档零事件；点进
 * iframe 后 `document.activeElement === IFRAME`，父 `window` 也收不到 keydown）。
 *
 * iframe 的 sandbox 含 `allow-same-origin`，故 `contentDocument` 与父文档同源、
 * 可由父侧直接访问 —— 在这里补挂监听器即可，无需给沙箱加 `allow-scripts`
 * （html 里的脚本依旧不执行）。srcdoc 每次变化都会换一份新文档，旧文档连同
 * 监听器一起销毁，所以不需要显式解绑；挂载必须幂等（见下方轮询说明），
 * 标记写在 documentElement 的 dataset 上即可随文档对象走、换文档自动失效。
 */
function attachFrameListeners(): void {
  const doc = frameRef.value?.contentDocument;
  if (!doc || !doc.documentElement) return;
  // 跳过 iframe 的初始占位文档（无 src / srcdoc 未加载时引擎提供的同步 about:blank
  // 文档）：它有完整的 documentElement，若把监听挂在这里，srcdoc 正式加载替换文档
  // 后监听器随占位文档一起销毁，事件全部丢失（#405 在 Linux / macOS e2e 的根因
  // —— Windows WebView2 srcdoc 加载快、轮询 tick 时往往已是最终文档才没踩）。
  // 只排除明确的 about:blank，其它 location 一律挂载，避免个别引擎对 srcdoc 文档
  // 的 location 报法不同（如空串）导致永远不挂。
  if (doc.location?.href === "about:blank") return;
  if (doc.documentElement.dataset[ATTACH_FLAG] === "1") return;
  doc.documentElement.dataset[ATTACH_FLAG] = "1";
  doc.addEventListener("wheel", (ev) => emit("inner-wheel", ev), { passive: false });
  doc.addEventListener("keydown", (ev) => emit("inner-keydown", ev));
}

function onFrameLoad(): void {
  attachFrameListeners();
}

/**
 * load 兜底轮询：只靠 @load 挂监听在 WebKit 系不可靠 —— WebKitGTK / WKWebView
 * 上 srcdoc 文档「可交互」（body 就绪）早于 load 事件，且 iframe 初建还会先以
 * about:blank 文档触发一次 load，监听可能挂在随即被替换的初始文档上、或晚于
 * 第一次用户输入（#405 在 Linux / macOS e2e 失败的根因，Windows WebView2 只是
 * 时序上恰好没踩）。改为低频轮询幂等挂载：已挂载时本轮只剩一次 dataset 读取，
 * 开销可忽略；srcdoc 换文档后下一轮自动重挂。e2e 也以该标记为「监听已挂上」
 * 的就绪判据（presentation-mode.spec.ts）。
 */
let attachPollTimer: ReturnType<typeof setInterval> | null = null;

function startAttachPoll(): void {
  if (attachPollTimer !== null) return;
  attachPollTimer = setInterval(attachFrameListeners, ATTACH_POLL_MS);
  attachFrameListeners();
}

function stopAttachPoll(): void {
  if (attachPollTimer !== null) {
    clearInterval(attachPollTimer);
    attachPollTimer = null;
  }
}

onMounted(startAttachPoll);
onBeforeUnmount(stopAttachPoll);

defineExpose({
  /** 返回预览区的滚动容器，供滚动同步使用 */
  getScrollDom: (): HTMLElement | null => scrollRef.value,
  getContentContainer: (): HTMLElement | null => scrollRef.value,
});
</script>

<template>
  <div ref="scrollRef" class="html-preview">
    <!--
      只读预览：把 HTML 源码作为文档渲染。
      sandbox 不授予 allow-scripts，脚本不执行（与"预览区隔离"。XSS 防护一致）。
      allow-same-origin + allow-popups：允许相对资源与弹窗。
      注意：allow-same-origin 同时让父侧可以访问 contentDocument（见 attachFrameListeners），
      这是把子文档事件接回父组件的依据，**不要移除**。
      不用 loading="lazy"：HTML 预览必然在视区内，lazy 只会让「占位文档 → srcdoc
      文档」的替换时序更不可控（#405）。
    -->
    <iframe
      ref="frameRef"
      :srcdoc="source"
      class="html-iframe"
      sandbox="allow-same-origin allow-popups"
      @load="onFrameLoad"
    ></iframe>
  </div>
</template>

<style scoped>
.html-preview {
  height: 100%;
  width: 100%;
  background: var(--murasaki-background);
  color: var(--murasaki-ink);
}
.html-preview::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
.html-frame-container {
  height: 100%;
  width: 100%;
}
.html-iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: none;
  background: var(--murasaki-background);
}
</style>