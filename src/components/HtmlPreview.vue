<script setup lang="ts">
import { ref } from "vue";

interface Props {
  /** 原始 HTML 内容 */
  source?: string;
}

withDefaults(defineProps<Props>(), {
  source: "",
});

const emit = defineEmits<{
  /** 子文档内的滚轮事件（iframe 会吞掉滚轮，父文档收不到，见下方 onFrameLoad） */
  (e: "inner-wheel", ev: WheelEvent): void;
  /** 子文档内的键盘事件（同上，焦点在 iframe 内时父 window 收不到 keydown） */
  (e: "inner-keydown", ev: KeyboardEvent): void;
}>();

const scrollRef = ref<HTMLDivElement | null>(null);
const frameRef = ref<HTMLIFrameElement | null>(null);

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
 * 监听器一起销毁，所以只在每次 load 后重新挂即可，不需要显式解绑。
 */
function onFrameLoad(): void {
  const doc = frameRef.value?.contentDocument;
  if (!doc) return;
  doc.addEventListener("wheel", (ev) => emit("inner-wheel", ev), { passive: false });
  doc.addEventListener("keydown", (ev) => emit("inner-keydown", ev));
}

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
      注意：allow-same-origin 同时让父侧可以访问 contentDocument（见 onFrameLoad），
      这是把子文档事件接回父组件的依据，**不要移除**。
    -->
    <iframe
      ref="frameRef"
      :srcdoc="source"
      class="html-iframe"
      sandbox="allow-same-origin allow-popups"
      loading="lazy"
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