<script setup lang="ts">
import { ref, watch } from "vue";
import { NModal, NButton, NSpace, NText, NSpin } from "naive-ui";
import { invoke } from "@tauri-apps/api/core";
import { basename, extname } from "../utils/path";
import { useDialogStore } from "../stores/useDialogStore";

interface Props {
  visible: boolean;
  /** 图片文件绝对路径 */
  path: string | null;
}

const props = withDefaults(defineProps<Props>(), {
  path: null,
});

const emit = defineEmits<{
  (e: "close"): void;
}>();

const dialog = useDialogStore();

const dataUrl = ref<string>("");
const loading = ref(false);
const errorMsg = ref<string>("");
const fileName = ref<string>("");

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

function mimeOf(path: string): string {
  return MIME_BY_EXT[extname(path)] ?? "image/png";
}

async function loadImage(path: string): Promise<void> {
  loading.value = true;
  errorMsg.value = "";
  dataUrl.value = "";
  fileName.value = basename(path);

  // SVG 是文本格式，直接读取文本即可
  if (extname(path) === "svg") {
    try {
      const text = await invoke<string>("read_text_file", { path });
      dataUrl.value = `data:image/svg+xml;utf8,${encodeURIComponent(text)}`;
    } catch (err) {
      errorMsg.value = `读取失败: ${err}`;
    } finally {
      loading.value = false;
    }
    return;
  }

  // 其他图片类型：读取二进制并转 Base64
  try {
    const bytes = await invoke<number[]>("read_binary_file", { path });
    if (!bytes || bytes.length === 0) {
      errorMsg.value = "图片为空或读取失败";
      return;
    }
    // 二进制转 Base64：分块拼接避免 String.fromCharCode 一次性堆栈溢出
    const CHUNK = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const end = Math.min(i + CHUNK, bytes.length);
      binary += String.fromCharCode(...bytes.slice(i, end));
    }
    const base64 = btoa(binary);
    dataUrl.value = `data:${mimeOf(path)};base64,${base64}`;
  } catch (err) {
    errorMsg.value = `读取失败: ${err}`;
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.visible, props.path] as const,
  (newVal, oldVal) => {
    const [v, p] = newVal;
    const prevV = oldVal?.[0];
    if (v && p && (prevV !== v || p !== "")) {
      void loadImage(p);
    }
    if (!v) {
      // 关闭时清理
      dataUrl.value = "";
      errorMsg.value = "";
      fileName.value = "";
    }
  },
  { immediate: true }
);

/** 复制图片路径到剪贴板 */
async function copyPath(): Promise<void> {
  if (!props.path) return;
  try {
    await navigator.clipboard.writeText(props.path);
  } catch {
    // 退回 execCommand 方案
    const ta = document.createElement("textarea");
    ta.value = props.path;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      // 忽略
    }
    document.body.removeChild(ta);
  }
}

/** 在系统资源管理器中显示 */
async function revealInExplorer(): Promise<void> {
  if (!props.path) return;
  try {
    await invoke("reveal_in_explorer", { path: props.path });
  } catch (err) {
    dialog.alert({ message: `无法在资源管理器中显示: ${err}`, variant: "error" });
  }
}
</script>

<template>
  <NModal
    :show="visible"
    :mask-closable="true"
    :close-on-esc="true"
    preset="card"
    :title="fileName || '图片预览'"
    style="width: min(960px, 92vw); max-height: 88vh"
    @update:show="(v: boolean) => !v && emit('close')"
    @esc="emit('close')"
  >
    <div class="image-modal-body">
      <NSpin v-if="loading" size="large" class="loading-spin" />
      <div v-else-if="errorMsg" class="error-block">
        <NText type="error">{{ errorMsg }}</NText>
      </div>
      <div v-else-if="dataUrl" class="image-container">
        <img
          :src="dataUrl"
          :alt="fileName"
          class="preview-image"
        />
      </div>
      <div v-else class="empty-block">
        <NText depth="3">无图片可预览</NText>
      </div>

      <div v-if="props.path" class="path-line" :title="props.path">
        <NText depth="3" code class="path-text">{{ props.path }}</NText>
      </div>
    </div>

    <template #footer>
      <NSpace justify="end" :size="8">
        <NButton size="small" @click="copyPath">复制路径</NButton>
        <NButton size="small" @click="revealInExplorer">在资源管理器中显示</NButton>
        <NButton size="small" type="primary" @click="emit('close')">关闭</NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.image-modal-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 200px;
  max-height: calc(88vh - 140px);
}
.loading-spin {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px 0;
}
.error-block,
.empty-block {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px 0;
}
.image-container {
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
  max-height: calc(88vh - 200px);
  background: #f6f8fa;
  border-radius: 4px;
  padding: 12px;
}
.preview-image {
  max-width: 100%;
  max-height: calc(88vh - 220px);
  object-fit: contain;
  border-radius: 2px;
  user-select: none;
  -webkit-user-drag: none;
}
.path-line {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.path-text {
  word-break: break-all;
  white-space: normal;
  font-size: 11px;
}
</style>
