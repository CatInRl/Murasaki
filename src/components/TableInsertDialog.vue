<script setup lang="ts">
import { ref, watch } from "vue";
import { NModal, NCard, NInputNumber, NButton, NSpace, NText } from "naive-ui";

interface Props {
  visible: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: "confirm", rows: number, cols: number): void;
  (e: "cancel"): void;
}>();

/** 行数（不含表头） */
const rows = ref(2);
/** 列数 */
const cols = ref(3);

// 每次打开时重置为默认值
watch(
  () => props.visible,
  (v) => {
    if (v) {
      rows.value = 2;
      cols.value = 3;
    }
  }
);

function onConfirm(): void {
  const r = Math.max(1, Math.min(50, rows.value));
  const c = Math.max(1, Math.min(20, cols.value));
  emit("confirm", r, c);
}

function onCancel(): void {
  emit("cancel");
}
</script>

<template>
  <NModal
    :show="visible"
    :mask-closable="false"
    :close-on-esc="true"
    preset="card"
    :title="$t('editor.tableDialog.title')"
    style="width: 360px"
    @esc="onCancel"
  >
    <NCard :bordered="false" size="small">
      <div class="table-form">
        <div class="form-row">
          <NText class="form-label">{{ $t('editor.tableDialog.rowsLabel') }}</NText>
          <NInputNumber
            v-model:value="rows"
            :min="1"
            :max="50"
            size="small"
            style="width: 120px"
          />
        </div>
        <div class="form-row">
          <NText class="form-label">{{ $t('editor.tableDialog.colsLabel') }}</NText>
          <NInputNumber
            v-model:value="cols"
            :min="1"
            :max="20"
            size="small"
            style="width: 120px"
          />
        </div>
      </div>
    </NCard>

    <template #footer>
      <NSpace justify="end">
        <NButton size="small" @click="onCancel">{{ $t('common.cancel') }}</NButton>
        <NButton size="small" type="primary" @click="onConfirm">
          {{ $t('editor.tableDialog.insert') }}
        </NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.table-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.form-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.form-label {
  font-size: 13px;
  color: #555;
}
</style>
