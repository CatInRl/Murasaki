<script setup lang="ts">
/**
 * UpdateDialog — 自定义更新提示对话框（ADR-0012 / T1.1）
 *
 * 触发场景：
 * - 用户点击「检查更新…」菜单项且检测到新版本（非静默 check）
 * - 由 useUpdater.onUpdateAvailable 回调打开
 *
 * 显示内容：版本号 / 发布说明（纯文本）/ 「立即更新 / 稍后」按钮
 * 0.4.0 不做下载进度详细显示（用 indeterminate，按钮 loading 态）。
 */
import { NModal, NCard, NButton, NSpace, NText, NTag } from "naive-ui";
import type { UpdateInfo } from "../composables/useUpdater";

interface Props {
  visible: boolean;
  update: UpdateInfo | null;
  /** 下载安装进行中（按钮 loading 态） */
  downloading?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  downloading: false,
});

const emit = defineEmits<{
  (e: "cancel"): void;
  (e: "confirm", update: UpdateInfo): void;
}>();

function onCancel(): void {
  emit("cancel");
}

function onConfirm(): void {
  if (props.update) {
    emit("confirm", props.update);
  }
}
</script>

<template>
  <NModal
    :show="visible"
    :mask-closable="false"
    :close-on-esc="!downloading"
    preset="card"
    title="发现新版本"
    style="width: 520px"
    @esc="!downloading && onCancel()"
  >
    <NCard :bordered="false" size="small">
      <div v-if="update" class="update-content">
        <!-- 版本号 -->
        <div class="version-row">
          <NText depth="2">当前版本：</NText>
          <NText>{{ update.currentVersion }}</NText>
          <NText depth="2" style="margin-left: 16px">最新版本：</NText>
          <NTag type="success" size="small" :bordered="false">
            v{{ update.version }}
          </NTag>
        </div>

        <!-- 发布说明 -->
        <div class="release-notes">
          <NText depth="2" class="notes-title">发布说明</NText>
          <div class="notes-body">{{ update.body || "（无发布说明）" }}</div>
        </div>
      </div>
    </NCard>

    <template #footer>
      <NSpace justify="end">
        <NButton :disabled="downloading" @click="onCancel">稍后</NButton>
        <NButton
          type="primary"
          :loading="downloading"
          :disabled="!update"
          @click="onConfirm"
        >
          立即更新
        </NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.update-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.version-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 13px;
}

.release-notes {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.notes-title {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.notes-body {
  max-height: 280px;
  overflow-y: auto;
  padding: 12px;
  background: var(--murasaki-surface-muted, rgba(0, 0, 0, 0.03));
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--murasaki-font-mono, "JetBrains Mono", monospace);
}
</style>
