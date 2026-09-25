<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RotateCw, FolderOpen, FilePlus, FolderPlus, Clipboard } from "lucide-vue-next";
import { NScrollbar, NButton, NInput } from "naive-ui";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { useFileOpsStore } from "../stores/useFileOpsStore";
import { useDialogStore } from "../stores/useDialogStore";
import { useContextMenuStore } from "../stores/useContextMenuStore";
import { provideFileTreeNav } from "../composables/useFileTreeNav";
import {
  flattenVisibleTree,
  indexOfPath,
  nextTreeIndex,
  rightArrowAction,
  leftArrowAction,
  type FlatTreeItem,
  type TreeNavKey,
} from "../utils/treeNavigation";
import TreeNode from "./TreeNode.vue";
import EmptyState from "./EmptyState.vue";
import Skeleton from "./Skeleton.vue";

const workspace = useWorkspaceStore();
const fileOps = useFileOpsStore();
const dialog = useDialogStore();
const contextMenu = useContextMenuStore();
const { t } = useI18n();

const emit = defineEmits<{
  (e: "select-file", path: string): void;
  (e: "preview-image", path: string): void;
}>();

function onSelectFile(path: string) {
  workspace.selectFile(path);
  emit("select-file", path);
}

// ===== 键盘导航（ARIA tree：roving tabindex + 方向键） =====
const expandedPaths = ref<Set<string>>(new Set());
const visibleItems = computed(() =>
  flattenVisibleTree(workspace.fileTree, (path) => expandedPaths.value.has(path))
);
const nav = provideFileTreeNav({
  expandedPaths,
  visiblePaths: computed(() => visibleItems.value.map((item) => item.path)),
});

/** 移动键盘焦点到指定可见条目 */
function focusItem(item: FlatTreeItem | undefined): void {
  if (!item) return;
  nav.setActive(item.path);
  nav.getRow(item.path)?.focus();
}

function onTreeKeydown(e: KeyboardEvent): void {
  // 内联重命名 / 新建输入框中，按键交给输入框自己处理
  if ((e.target as HTMLElement | null)?.closest("input, textarea")) return;

  const items = visibleItems.value;
  if (items.length === 0) return;
  const current = indexOfPath(items, nav.focusPath.value);

  switch (e.key) {
    case "ArrowDown":
    case "ArrowUp":
    case "Home":
    case "End":
      e.preventDefault();
      focusItem(items[nextTreeIndex(items, current, e.key as TreeNavKey)]);
      break;
    case "ArrowRight": {
      const action = rightArrowAction(items, current);
      if (!action) return;
      e.preventDefault();
      if (action.kind === "focus") focusItem(items[action.index]);
      else if (action.kind === "expand") nav.setExpanded(action.path, true);
      break;
    }
    case "ArrowLeft": {
      const action = leftArrowAction(items, current);
      if (!action) return;
      e.preventDefault();
      if (action.kind === "focus") focusItem(items[action.index]);
      else if (action.kind === "collapse") nav.setExpanded(action.path, false);
      break;
    }
    case "Enter":
    case " ": {
      const item = items[current];
      if (!item) return;
      e.preventDefault();
      if (item.type === "directory") {
        if (!item.hasChildren) return;
        nav.setExpanded(item.path, !item.expanded);
      } else {
        onSelectFile(item.path);
      }
      break;
    }
  }
}

// ===== 空白区域右键菜单（在工作区根目录新建/粘贴/在资源管理器中打开） =====
const rootCreatingName = ref("");

function onEmptyContextMenu(e: MouseEvent): void {
  const root = workspace.workspacePath;
  if (!root) return;
  contextMenu.show(e, [
    {
      label: t("common.newFile"),
      icon: FilePlus,
      action: () => {
        fileOps.beginRootCreate("file");
        rootCreatingName.value = "";
      },
    },
    {
      label: t("common.newFolder"),
      icon: FolderPlus,
      action: () => {
        fileOps.beginRootCreate("directory");
        rootCreatingName.value = "";
      },
    },
    { separator: true },
    {
      label: t("common.paste"),
      icon: Clipboard,
      disabled: !fileOps.hasClipboard,
      action: async () => {
        try {
          await fileOps.paste(root);
        } catch (err) {
          dialog.alert({ message: t("common.error.pasteFailed", { error: err }), variant: "error" });
        }
      },
    },
    { separator: true },
    {
      label: t("common.revealInExplorer"),
      icon: FolderOpen,
      action: async () => {
        try {
          await fileOps.revealInExplorer(root);
        } catch (err) {
          dialog.alert({ message: t("common.error.revealFailed", { error: err }), variant: "error" });
        }
      },
    },
  ]);
}

async function submitRootCreating(): Promise<void> {
  const name = rootCreatingName.value.trim();
  if (!name || !workspace.workspacePath) {
    fileOps.endRootCreate();
    return;
  }
  try {
    if (fileOps.rootCreatingType === "file") {
      await fileOps.createFile(workspace.workspacePath, name);
    } else {
      await fileOps.createDirectory(workspace.workspacePath, name);
    }
  } catch (err) {
    dialog.alert({ message: t("common.error.createFailed", { error: err }), variant: "error" });
  } finally {
    fileOps.endRootCreate();
    rootCreatingName.value = "";
  }
}

function cancelRootCreating(): void {
  fileOps.endRootCreate();
  rootCreatingName.value = "";
}

// ===== 空状态：打开工作区 =====
async function onOpenWorkspace(): Promise<void> {
  await workspace.openFolderDialog();
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
        :title="$t('editor.fileTree.refresh')"
        :loading="workspace.loading"
        @click="workspace.refreshTree()"
      >
        <RotateCw :size="14" />
      </NButton>
    </div>

    <!-- 文件树内容 -->
    <NScrollbar class="tree-scroll">
      <Skeleton
        v-if="workspace.loading && workspace.fileTree.length === 0"
        :lines="4"
      />
      <EmptyState
        v-else-if="!workspace.hasWorkspace"
        :icon="FolderOpen"
        :title="$t('editor.fileTree.noWorkspace')"
        :description="$t('editor.fileTree.noWorkspaceDesc')"
        :action-text="$t('editor.fileTree.openFolder')"
        :action-icon="FolderOpen"
        @action="onOpenWorkspace"
      />
      <div v-else class="tree-content">
        <!-- 根目录新建输入框 -->
        <div v-if="fileOps.rootCreating" class="root-creating-row">
          <svg
            v-if="fileOps.rootCreatingType === 'directory'"
            class="root-creating-icon"
            width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
          >
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
          </svg>
          <svg
            v-else
            class="root-creating-icon"
            width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          <NInput
            v-model:value="rootCreatingName"
            size="tiny"
            autofocus
            :placeholder="fileOps.rootCreatingType === 'file' ? t('editor.fileTree.newFilePlaceholder') : t('editor.fileTree.newFolderPlaceholder')"
            @keyup.enter="submitRootCreating"
            @keyup.escape="cancelRootCreating"
            @blur="submitRootCreating"
          />
        </div>
        <div
          class="tree-root"
          role="tree"
          :aria-label="$t('editor.fileTree.ariaLabel')"
          @keydown="onTreeKeydown"
        >
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
      </div>
    </NScrollbar>
  </div>
</template>

<style scoped>
.file-tree {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--murasaki-surface);
}
.tree-toolbar {
  height: 32px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  border-bottom: 1px solid var(--murasaki-line);
  gap: 4px;
  background: var(--murasaki-surface);
}
.toolbar-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--murasaki-ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.tree-scroll {
  flex: 1;
  min-height: 0;
}
.tree-content {
  padding: 4px 0;
}
.root-creating-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 4px 14px;
  background: var(--murasaki-purple-50);
  border-radius: 3px;
  margin: 2px 4px;
}
.root-creating-icon {
  color: var(--murasaki-primary);
  flex-shrink: 0;
}
</style>
