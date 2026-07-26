<script setup lang="ts">
import { ref } from "vue";
import { NScrollbar, NSpin, NEmpty, NButton, NDropdown, NInput } from "naive-ui";
import type { DropdownOption } from "naive-ui";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { useFileOpsStore } from "../stores/useFileOpsStore";
import TreeNode from "./TreeNode.vue";

const workspace = useWorkspaceStore();
const fileOps = useFileOpsStore();

const emit = defineEmits<{
  (e: "select-file", path: string): void;
  (e: "preview-image", path: string): void;
}>();

function onSelectFile(path: string) {
  workspace.selectFile(path);
  emit("select-file", path);
}

// ===== 空白区域右键菜单（在工作区根目录新建文件/文件夹） =====
const emptyMenuVisible = ref(false);
const emptyMenuX = ref(0);
const emptyMenuY = ref(0);

const emptyMenuOptions: DropdownOption[] = [
  { label: "新建文件", key: "new-file" },
  { label: "新建文件夹", key: "new-folder" },
];

function onEmptyContextMenu(e: MouseEvent): void {
  if (!workspace.hasWorkspace) return;
  e.preventDefault();
  emptyMenuX.value = e.clientX;
  emptyMenuY.value = e.clientY;
  emptyMenuVisible.value = true;
}

function closeEmptyMenu(): void {
  emptyMenuVisible.value = false;
}

// ===== 根目录新建输入框 =====
const rootCreating = ref(false);
const rootCreatingType = ref<"file" | "directory">("file");
const rootCreatingName = ref("");

async function onEmptyMenuSelect(key: string): Promise<void> {
  closeEmptyMenu();
  if (!workspace.workspacePath) return;
  if (key === "new-file" || key === "new-folder") {
    rootCreatingType.value = key === "new-file" ? "file" : "directory";
    rootCreatingName.value = "";
    rootCreating.value = true;
  }
}

async function submitRootCreating(): Promise<void> {
  const name = rootCreatingName.value.trim();
  if (!name || !workspace.workspacePath) {
    rootCreating.value = false;
    return;
  }
  try {
    if (rootCreatingType.value === "file") {
      await fileOps.createFile(workspace.workspacePath, name);
    } else {
      await fileOps.createDirectory(workspace.workspacePath, name);
    }
  } catch (err) {
    alert(`新建失败: ${err}`);
  } finally {
    rootCreating.value = false;
    rootCreatingName.value = "";
  }
}

function cancelRootCreating(): void {
  rootCreating.value = false;
  rootCreatingName.value = "";
}
</script>

<template>
  <div class="file-tree" @contextmenu="onEmptyContextMenu">
    <!-- 顶部工具栏 -->
    <div class="tree-toolbar">
      <span class="toolbar-title">{{ workspace.workspaceName }}</span>
      <NButton
        size="tiny"
        quaternary
        circle
        title="刷新"
        :loading="workspace.loading"
        @click="workspace.refreshTree()"
      >
        <span style="font-size: 14px">↻</span>
      </NButton>
    </div>

    <!-- 文件树内容 -->
    <NScrollbar class="tree-scroll">
      <div v-if="workspace.loading && workspace.fileTree.length === 0" class="tree-loading">
        <NSpin size="small" />
        <span style="margin-left: 8px; font-size: 12px; color: #999">加载中…</span>
      </div>
      <NEmpty
        v-else-if="!workspace.hasWorkspace"
        description="未打开工作区"
        size="small"
        style="padding: 24px 0"
      />
      <div v-else class="tree-content">
        <!-- 根目录新建输入框 -->
        <div v-if="rootCreating" class="root-creating-row">
          <span class="node-icon">
            {{ rootCreatingType === "file" ? "·" : "▸" }}
          </span>
          <NInput
            v-model:value="rootCreatingName"
            size="tiny"
            autofocus
            :placeholder="rootCreatingType === 'file' ? '新文件名.md' : '新文件夹名'"
            @keyup.enter="submitRootCreating"
            @keyup.escape="cancelRootCreating"
            @blur="submitRootCreating"
          />
        </div>
        <TreeNode
          v-for="node in workspace.fileTree"
          :key="node.path"
          :node="node"
          :selected-path="workspace.selectedFilePath"
          :level="0"
          @select-file="onSelectFile"
          @preview-image="(p) => emit('preview-image', p)"
        />
      </div>
    </NScrollbar>

    <!-- 空白区域右键菜单 -->
    <NDropdown
      placement="bottom-start"
      trigger="manual"
      :x="emptyMenuX"
      :y="emptyMenuY"
      :options="emptyMenuOptions"
      :show="emptyMenuVisible"
      :on-clickoutside="closeEmptyMenu"
      @select="onEmptyMenuSelect"
    />
  </div>
</template>

<style scoped>
.file-tree {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.tree-toolbar {
  height: 32px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
  border-bottom: 1px solid #eee;
  gap: 4px;
}
.toolbar-title {
  font-size: 12px;
  font-weight: 600;
  color: #333;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.tree-scroll {
  flex: 1;
  min-height: 0;
}
.tree-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 0;
}
.tree-content {
  padding: 4px 0;
}
.root-creating-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
}
.root-creating-row .node-icon {
  font-size: 12px;
  color: #999;
  width: 12px;
  flex-shrink: 0;
}
</style>
