<script setup lang="ts">
import { ref } from "vue";

interface Props {
  /** 原始 HTML 内容 */
  source?: string;
}

withDefaults(defineProps<Props>(), {
  source: "",
});

const scrollRef = ref<HTMLDivElement | null>(null);

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
    -->
    <iframe
      :srcdoc="source"
      class="html-iframe"
      sandbox="allow-same-origin allow-popups"
      loading="lazy"
    ></iframe>
  </div>
</template>

<style scoped>
.html-preview {
  height: 100%;
  width: 100%;
  background: #fff;
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
  background: #fff;
}
</style>