<script setup lang="ts">
import { toRef } from "vue";
import { NButton, NButtonGroup } from "naive-ui";
import FileTree from "./FileTree.vue";
import OutlinePanel from "./OutlinePanel.vue";
import { useOutline } from "../composables/useOutline";
import type { SidebarView } from "../types";

interface Props {
  /** 当前打开的文件路径（用于大纲解析） */
  currentFilePath?: string | null;
  /** 侧栏当前视图（受控） */
  activeView?: SidebarView;
  /** 是否已打开工作区（控制"文件树"按钮可见性） */
  hasWorkspace?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  currentFilePath: null,
  activeView: "files",
  hasWorkspace: false,
});

const emit = defineEmits<{
  (e: "select-file", path: string): void;
  (e: "jump-to-line", line: number): void;
  (e: "preview-image", path: string): void;
  (e: "update:activeView", view: SidebarView): void;
}>();

function setView(view: SidebarView): void {
  emit("update:activeView", view);
}

// 大纲：监听当前文件路径，自动拉取
const filePathRef = toRef(props, "currentFilePath");
const { outline: outlineItems, loading: outlineLoading } = useOutline(filePathRef);
</script>

<template>
  <div class="sidebar">
    <!-- 顶部切换按钮 -->
    <div class="sidebar-tabs">
      <NButtonGroup size="small">
        <NButton
          v-if="hasWorkspace"
          :type="activeView === 'files' ? 'primary' : 'default'"
          title="文件树 (Ctrl+Shift+E)"
          @click="setView('files')"
        >
          文件树
        </NButton>
        <NButton
          :type="activeView === 'outline' ? 'primary' : 'default'"
          title="大纲 (Ctrl+Shift+M)"
          @click="setView('outline')"
        >
          大纲
        </NButton>
      </NButtonGroup>
    </div>

    <!-- 内容区 -->
    <div class="sidebar-content">
      <FileTree
        v-show="activeView === 'files'"
        @select-file="(p) => emit('select-file', p)"
        @preview-image="(p) => emit('preview-image', p)"
      />
      <OutlinePanel
        v-show="activeView === 'outline'"
        :items="outlineItems"
        :loading="outlineLoading"
        @jump-to-line="(line) => emit('jump-to-line', line)"
      />
    </div>
  </div>
</template>

<style scoped>
.sidebar {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #fafafa;
}
.sidebar-tabs {
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-bottom: 1px solid #e0e0e6;
  background: #fff;
}
.sidebar-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
