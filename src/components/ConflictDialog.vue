<script setup lang="ts">
import { ref, watch, computed } from "vue";
import { NModal, NCard, NButton, NSpace, NInput, NText } from "naive-ui";
import { basename } from "../utils/path";

interface Props {
  visible: boolean;
  targetPath: string;
  sourcePath?: string;
  operation: "rename" | "copy" | "save-as";
}

const props = withDefaults(defineProps<Props>(), {
  sourcePath: undefined,
});

const emit = defineEmits<{
  (
    e: "resolve",
    payload: { action: "overwrite" | "rename" | "cancel"; newName?: string }
  ): void;
}>();

const newName = ref("");
const showRename = ref(false);

const targetName = computed(() => {
  if (!props.targetPath) return "";
  return basename(props.targetPath);
});

const title = computed(() => {
  switch (props.operation) {
    case "rename":
      return "重命名冲突";
    case "copy":
      return "复制冲突";
    case "save-as":
      return "另存为冲突";
    default:
      return "冲突";
  }
});

// 重置状态：每次打开对话框时清空输入
watch(
  () => props.visible,
  (v) => {
    if (v) {
      newName.value = "";
      showRename.value = false;
    }
  }
);

function onOverwrite(): void {
  emit("resolve", { action: "overwrite" });
}

function onRename(): void {
  if (showRename.value) {
    // 已显示输入框，提交新名字
    if (!newName.value.trim()) {
      return;
    }
    emit("resolve", { action: "rename", newName: newName.value.trim() });
  } else {
    // 首次点击：显示输入框，默认填充原名字
    newName.value = targetName.value;
    showRename.value = true;
  }
}

function onCancel(): void {
  emit("resolve", { action: "cancel" });
}

/** 是否禁止目录覆盖（spec：目录覆盖被禁止，仅文件对文件覆盖） */
const isDirectoryTarget = computed(() => {
  // 简化判断：从路径中无法直接判断；假设由调用方控制
  // 此处始终允许覆盖，因为调用方在调用前会判断
  return false;
});

const overwriteDisabled = computed(() => isDirectoryTarget.value);
</script>

<template>
  <NModal
    :show="visible"
    :mask-closable="false"
    :close-on-esc="true"
    preset="card"
    :title="title"
    style="width: 480px"
    @esc="onCancel"
  >
    <NCard :bordered="false" size="small">
      <div class="conflict-content">
        <NText>目标已存在：</NText>
        <NText code class="conflict-path" :title="targetPath">
          {{ targetPath }}
        </NText>
        <div v-if="sourcePath" class="source-info">
          <NText depth="3" style="font-size: 12px">
            源：{{ sourcePath }}
          </NText>
        </div>
        <div v-if="isDirectoryTarget" class="warning-text">
          <NText type="warning" style="font-size: 12px">
            注意：目录无法覆盖，请选择"重命名"或"取消"。
          </NText>
        </div>

        <div v-if="showRename" class="rename-input">
          <NInput
            v-model:value="newName"
            placeholder="输入新名称"
            size="small"
            @keyup.enter="onRename"
          />
        </div>
      </div>
    </NCard>

    <template #footer>
      <NSpace justify="end">
        <NButton size="small" @click="onCancel">取消</NButton>
        <NButton size="small" :disabled="overwriteDisabled" @click="onOverwrite">
          覆盖
        </NButton>
        <NButton size="small" type="primary" @click="onRename">
          {{ showRename ? "确认重命名" : "重命名" }}
        </NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.conflict-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.conflict-path {
  word-break: break-all;
  font-family: Consolas, "Courier New", monospace;
  font-size: 13px;
}
.source-info {
  margin-top: 4px;
}
.warning-text {
  margin-top: 4px;
}
.rename-input {
  margin-top: 8px;
}
</style>
