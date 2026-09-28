<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import {
  Pencil,
  Scissors,
  Copy,
  Clipboard,
  Trash2,
  FolderOpen,
  FilePlus,
  FolderPlus,
  Link2,
  Link,
  FileText,
  Image as ImageIcon,
  ExternalLink,
} from "lucide-vue-next";
import { NInput } from "naive-ui";
import { useFileOpsStore } from "../stores/useFileOpsStore";
import { useDialogStore } from "../stores/useDialogStore";
import { useContextMenuStore } from "../stores/useContextMenuStore";
import { usePersistenceStore } from "../stores/usePersistenceStore";
import { useToastStore } from "../stores/useToastStore";
import type { MenuItem } from "../stores/useContextMenuStore";
import { useFileTreeNav } from "../composables/useFileTreeNav";
import { basename } from "../utils/path";
import type { TreeNode } from "../types";
import {
  isMarkdownFile,
  isHtmlFile,
  isImageFile,
  isEditableTextFile,
  isLargeExtensionlessFile,
  EXTENSIONLESS_TEXT_MAX_SIZE,
} from "../utils/fileKind";

interface Props {
  node: TreeNode;
  /** 当前选中的文件路径（用于高亮） */
  selectedPath?: string | null;
  /** 缩进层级（从 0 开始） */
  level?: number;
}

const props = withDefaults(defineProps<Props>(), {
  selectedPath: null,
  level: 0,
});

const emit = defineEmits<{
  (e: "select-file", path: string): void;
  /** 打开图片预览 */
  (e: "preview-image", path: string): void;
}>();

const fileOps = useFileOpsStore();
const dialog = useDialogStore();
const contextMenu = useContextMenuStore();
const persistence = usePersistenceStore();
const toast = useToastStore();

const fileTreeNav = useFileTreeNav();
const { t } = useI18n();

/**
 * 用系统默认程序打开（issue #307）。
 * 应用打不开的文件（pdf / docx / zip / exe / 未知后缀 等）此前点击与右键都毫无反应，
 * 这里给唯一实际出口；失败时用 dialog 说明，不静默。
 */
async function openWithDefaultApp(path: string): Promise<void> {
  try {
    await fileOps.openWithDefaultApp(path);
  } catch (err) {
    dialog.alert({
      message: t("common.error.openWithDefaultFailed", { error: err }),
      variant: "error",
    });
  }
}

/** 长条目显示方案：wrap=自动换行 / hover=省略号+悬停显示完整 */
const wrapMode = computed(() => persistence.settings.entryOverflowMode === "wrap");

/** 目录是否有子节点（决定 aria-expanded 与 → 键是否可用） */
const hasChildren = computed(
  () => props.node.type === "directory" && (props.node.children?.length ?? 0) > 0
);

/** 目录展开状态（统一由 useFileTreeNav 持有，供键盘导航计算可见节点） */
const expanded = computed(
  () => props.node.type === "directory" && fileTreeNav.isExpanded(props.node.path)
);

/** roving tabindex：树内仅一个节点行可被 Tab 进入 */
const isFocusTarget = computed(() => fileTreeNav.focusPath.value === props.node.path);

/** 节点行 DOM：登记到导航上下文，供方向键移动焦点 */
const rowEl = ref<HTMLElement | null>(null);
watch(rowEl, (el) => fileTreeNav.registerRow(props.node.path, el), { flush: "post" });
onBeforeUnmount(() => fileTreeNav.registerRow(props.node.path, null));

// ===== 重命名状态 =====
const renaming = ref(false);
const renameValue = ref("");

// ===== 新建文件/文件夹对话框 =====
const creating = ref(false);
const creatingType = ref<"file" | "directory">("file");
const creatingName = ref("");

function toggle(): void {
  if (props.node.type === "directory") {
    fileTreeNav.setExpanded(props.node.path, !expanded.value);
  }
}

function onClick(): void {
  if (renaming.value || creating.value) return;
  fileTreeNav.setActive(props.node.path);
  if (props.node.type === "file") {
    if (canOpenInApp(props.node.name)) {
      // markdown / html / 文本代码 / 无后缀（#308 起不再按大小拦截）→ 按文本打开编辑
      emit("select-file", props.node.path);
    } else if (isImageFile(props.node.name)) {
      // 图片文件点击 → 弹预览窗
      emit("preview-image", props.node.path);
    } else {
      // 应用打不开的文件（pdf / docx / zip / exe / 未知后缀…）：此前是**静默无反应**
      // （issue #307）。给一次说明 + 兜底动作，别让「点了没反应」成为用户的结论。
      toast.info(t("toast.cannotOpenFile"), {
        description: basename(props.node.path),
        duration: 6000,
        action: {
          label: t("common.openWithDefaultApp"),
          onClick: () => void openWithDefaultApp(props.node.path),
        },
      });
    }
  } else {
    toggle();
  }
}

/**
 * 该文件能否在应用内打开为标签（markdown / html / 白名单文本代码 / 无后缀）
 *
 * 点击与右键菜单的「打开」共用同一口径，避免两处判定漂移（#308 改口径时两边都要动）。
 * 图片不在此列 —— 它走预览窗，见 `isImageFile`。
 */
function canOpenInApp(name: string): boolean {
  return isMarkdownFile(name) || isEditableTextFile(name);
}

/**
 * 文本/代码文件类（排除 markdown 与 html，用于图标分类）
 *
 * 与「能不能打开」的口径**故意不同**：无后缀文件即使能打开，只要不小（≥1MB）就仍按
 * 通用文件图标显示（更可能是二进制产物）；大小未知时也不按文本显示 —— 即图标继续沿用
 * #308 之前的判定，这是 issue #308 明确列为非目标的一条（图标不放宽）。
 */
function isTextFile(name: string): boolean {
  return (
    !isMarkdownFile(name) &&
    !isHtmlFile(name) &&
    isEditableTextFile(name) &&
    // 大小未知时按「大」处理：`isLargeExtensionlessFile` 对 ≥ 阈值返回 true，
    // 用阈值本身当哨兵即可让「未知」落到「不判为文本」那一边
    !isLargeExtensionlessFile(name, props.node.size ?? EXTENSIONLESS_TEXT_MAX_SIZE)
  );
}

/**
 * 文件树节点拖拽：
 * - 任何文件/目录都可拖（用于工作区内移动到其他目录）
 * - 图片文件额外携带 text/plain，供拖入编辑器时插入相对路径引用
 * 使用自定义 MIME 类型 application/x-murasaki-file-path 携带绝对路径
 */
const DRAG_MIME = "application/x-murasaki-file-path";

function onDragStart(e: DragEvent): void {
  if (props.node.type !== "file" && props.node.type !== "directory") return;
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(DRAG_MIME, props.node.path);
  if (props.node.type === "file" && isImageFile(props.node.name)) {
    e.dataTransfer.setData("text/plain", props.node.path);
    e.dataTransfer.effectAllowed = "copy";
  } else {
    // 工作区内移动：允许 move
    e.dataTransfer.effectAllowed = "move";
  }
}

// ===== 作为 drop target（仅目录接收） =====
const isDropTarget = ref(false);

function onDragOver(e: DragEvent): void {
  if (props.node.type !== "directory") return;
  if (!e.dataTransfer) return;
  // 必须阻止默认才能触发 drop
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  isDropTarget.value = true;
}

function onDragLeave(e: DragEvent): void {
  if (!e.relatedTarget || !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
    isDropTarget.value = false;
  }
}

async function onDrop(e: DragEvent): Promise<void> {
  isDropTarget.value = false;
  if (props.node.type !== "directory") return;
  e.preventDefault();
  if (!e.dataTransfer) return;
  e.stopPropagation();

  const targetDir = props.node.path;

  // 1. 优先：从文件树拖入的内部路径（工作区内移动）
  const internalPath = e.dataTransfer.getData(DRAG_MIME);
  if (internalPath) {
    try {
      await fileOps.moveInto(internalPath, targetDir);
    } catch (err) {
      dialog.alert({ message: t("common.error.moveFailed", { error: err }), variant: "error" });
    }
    return;
  }

  // 2. 外部拖入：复制文件到工作区（保留原文件）
  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    for (const file of Array.from(e.dataTransfer.files)) {
      // Tauri 拖入文件时 file.path 是绝对路径
      const externalPath = (file as unknown as { path?: string }).path;
      if (!externalPath) continue;
      try {
        await fileOps.copyInto(externalPath, targetDir);
      } catch (err) {
        dialog.alert({ message: t("common.error.copyFailed", { error: err }), variant: "error" });
      }
    }
  }
}

function isSelected(): boolean {
  return props.selectedPath === props.node.path;
}

// ===== 右键菜单（数据驱动，替换原 NDropdown）=====
function onContextMenu(e: MouseEvent): void {
  fileTreeNav.setActive(props.node.path);
  contextMenu.show(e, buildMenuItems());
}

/** 键盘呼出右键菜单：Shift+F10 / 菜单键，锚点取节点行左下角 */
function onRowKeydown(e: KeyboardEvent): void {
  if (!((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu")) return;
  e.preventDefault();
  e.stopPropagation();
  const rect = rowEl.value?.getBoundingClientRect();
  contextMenu.show(
    {
      clientX: rect ? rect.left + 12 : 0,
      clientY: rect ? rect.bottom - 2 : 0,
    },
    buildMenuItems()
  );
}

function buildMenuItems(): MenuItem[] {
  const isDir = props.node.type === "directory";
  const isFile = props.node.type === "file";
  const items: MenuItem[] = [];

  // 文件类型专属：打开 / 预览
  if (isFile) {
    if (canOpenInApp(props.node.name)) {
      items.push({
        label: t("common.open"),
        icon: FileText,
        action: () => emit("select-file", props.node.path),
      });
    } else if (isImageFile(props.node.name)) {
      items.push({
        label: t("common.preview"),
        icon: ImageIcon,
        action: () => emit("preview-image", props.node.path),
      });
    } else {
      // 应用打不开的文件（pdf / docx / zip / exe / 未知后缀 等）：此前右键只有通用项
      // （重命名/剪切/复制/删除/在资源管理器中显示…），**没有类型专属的「打开」**，
      // 点击也毫无反应（issue #307）。这里补上唯一实际出口 —— 交给系统默认程序。
      items.push({
        label: t("common.openWithDefaultApp"),
        icon: ExternalLink,
        action: () => void openWithDefaultApp(props.node.path),
      });
    }
  }

  if (isDir) {
    items.push({
      label: t("common.newFile"),
      icon: FilePlus,
      action: () => {
        creatingType.value = "file";
        creatingName.value = "";
        creating.value = true;
      },
    });
    items.push({
      label: t("common.newFolder"),
      icon: FolderPlus,
      action: () => {
        creatingType.value = "directory";
        creatingName.value = "";
        creating.value = true;
      },
    });
  }

  if (items.length > 0) items.push({ separator: true });

  items.push({
    label: t("common.rename"),
    icon: Pencil,
    action: () => {
      renameValue.value = props.node.name;
      renaming.value = true;
    },
  });
  items.push({
    label: t("common.cut"),
    icon: Scissors,
    action: () => fileOps.cut(props.node.path),
  });
  items.push({
    label: t("common.copy"),
    icon: Copy,
    action: () => fileOps.copy(props.node.path),
  });

  if (isDir && fileOps.hasClipboard) {
    items.push({
      label: t("common.paste"),
      icon: Clipboard,
      action: async () => {
        try {
          await fileOps.paste(props.node.path);
        } catch (err) {
          dialog.alert({ message: t("common.error.pasteFailed", { error: err }), variant: "error" });
        }
      },
    });
  }

  items.push({ separator: true });
  items.push({
    label: t("common.copyPath"),
    icon: Link2,
    action: async () => {
      try {
        await fileOps.copyAbsolutePath(props.node.path);
      } catch (err) {
        dialog.alert({ message: t("common.error.copyPathFailed", { error: err }), variant: "error" });
      }
    },
  });
  items.push({
    label: t("common.copyRelativePath"),
    icon: Link,
    action: async () => {
      try {
        await fileOps.copyRelativePath(props.node.path);
      } catch (err) {
        dialog.alert({ message: t("common.error.copyRelativePathFailed", { error: err }), variant: "error" });
      }
    },
  });

  items.push({ separator: true });
  items.push({
    label: t("common.delete"),
    icon: Trash2,
    danger: true,
    action: async () => {
      if (await dialog.confirm({ message: t("common.deleteConfirm", { name: props.node.name }), danger: true })) {
        try {
          await fileOps.deletePath(props.node.path);
        } catch (err) {
          dialog.alert({ message: t("common.error.deleteFailed", { error: err }), variant: "error" });
        }
      }
    },
  });
  items.push({
    label: t("common.revealInExplorer"),
    icon: FolderOpen,
    action: async () => {
      try {
        await fileOps.revealInExplorer(props.node.path);
      } catch (err) {
        dialog.alert({ message: t("common.error.revealFailed", { error: err }), variant: "error" });
      }
    },
  });

  return items;
}

// ===== 提交重命名 =====
async function submitRename(): Promise<void> {
  const newName = renameValue.value.trim();
  if (!newName || newName === props.node.name) {
    renaming.value = false;
    return;
  }
  try {
    await fileOps.renamePath(props.node.path, newName);
  } catch (err) {
    dialog.alert({ message: t("common.error.renameFailed", { error: err }), variant: "error" });
  } finally {
    renaming.value = false;
  }
}

function cancelRename(): void {
  renaming.value = false;
  renameValue.value = "";
}

// ===== 提交新建 =====
async function submitCreating(): Promise<void> {
  const name = creatingName.value.trim();
  if (!name) {
    creating.value = false;
    return;
  }
  try {
    if (creatingType.value === "file") {
      await fileOps.createFile(props.node.path, name);
    } else {
      await fileOps.createDirectory(props.node.path, name);
    }
    // 新建后展开当前目录
    if (props.node.type === "directory") {
      fileTreeNav.setExpanded(props.node.path, true);
    }
  } catch (err) {
    dialog.alert({ message: t("common.error.createFailed", { error: err }), variant: "error" });
  } finally {
    creating.value = false;
    creatingName.value = "";
  }
}

function cancelCreating(): void {
  creating.value = false;
  creatingName.value = "";
}
</script>

<template>
  <div class="tree-node">
    <!-- 节点行：显示名称或重命名输入框 -->
    <div
      v-if="!renaming"
      ref="rowEl"
      class="node-row"
      role="treeitem"
      :aria-level="level + 1"
      :aria-selected="isSelected()"
      :aria-expanded="hasChildren ? expanded : undefined"
      :tabindex="isFocusTarget ? 0 : -1"
      :class="{
        'is-directory': node.type === 'directory',
        'is-file': node.type === 'file',
        'is-selected': isSelected(),
        'is-md': isMarkdownFile(node.name),
        'is-image': isImageFile(node.name),
        'is-drop-target': isDropTarget,
        'wrap-mode': wrapMode,
      }"
      :style="{ paddingLeft: level * 14 + 8 + 'px' }"
      :draggable="(node.type === 'file') || (node.type === 'directory')"
      @focus="fileTreeNav.setActive(node.path)"
      @keydown="onRowKeydown"
      @click="onClick"
      @contextmenu="onContextMenu"
      @dragstart="onDragStart"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <!-- 目录：折叠箭头 + 文件夹图标 -->
      <svg
        v-if="node.type === 'directory'"
        class="node-arrow"
        :class="{ 'is-expanded': expanded }"
        width="12" height="12" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
      >
        <polyline points="9 18 15 12 9 6"/>
      </svg>
      <svg
        v-if="node.type === 'directory'"
        class="node-folder-icon"
        width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      >
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
      </svg>
      <!-- 文件：按类型分级图标（markdown=M 徽标 / html=角码 / 文本=文本文件 / 图片=图片 / 其他=通用文件） -->
      <template v-else>
        <span v-if="isMarkdownFile(node.name)" class="md-badge">M</span>
        <svg
          v-else-if="isHtmlFile(node.name)"
          class="node-file-icon is-html"
          width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <polyline points="10 12 8 14 10 16"/>
          <polyline points="14 12 16 14 14 16"/>
        </svg>
        <svg
          v-else-if="isTextFile(node.name)"
          class="node-file-icon is-text"
          width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
        </svg>
        <svg
          v-else-if="isImageFile(node.name)"
          class="node-file-icon"
          width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
        <svg
          v-else
          class="node-file-icon"
          width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
      </template>
      <span class="node-name" :title="node.name">{{ node.name }}</span>
    </div>

    <!-- 重命名输入框（替换节点行） -->
    <div
      v-else
      class="node-row rename-row"
      :style="{ paddingLeft: level * 14 + 8 + 'px' }"
    >
      <svg
        v-if="node.type === 'directory'"
        class="node-arrow"
        :class="{ 'is-expanded': expanded }"
        width="12" height="12" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
      >
        <polyline points="9 18 15 12 9 6"/>
      </svg>
      <span v-if="isMarkdownFile(node.name)" class="md-badge">M</span>
      <svg
        v-else
        class="node-file-icon"
        width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <NInput
        v-model:value="renameValue"
        size="tiny"
        autofocus
        :placeholder="node.name"
        @keyup.enter="submitRename"
        @keyup.escape="cancelRename"
        @blur="submitRename"
      />
    </div>

    <!-- 新建文件/文件夹输入框（在目录展开区域的顶部） -->
    <div
      v-if="creating && node.type === 'directory'"
      class="node-row creating-row"
      :style="{ paddingLeft: (level + 1) * 14 + 8 + 'px' }"
    >
      <svg
        v-if="creatingType === 'directory'"
        class="node-folder-icon"
        width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      >
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
      </svg>
      <svg
        v-else
        class="node-file-icon"
        width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <NInput
        v-model:value="creatingName"
        size="tiny"
        autofocus
        :placeholder="creatingType === 'file' ? $t('editor.fileTree.newFilePlaceholder') : $t('editor.fileTree.newFolderPlaceholder')"
        @keyup.enter="submitCreating"
        @keyup.escape="cancelCreating"
        @blur="submitCreating"
      />
    </div>

    <!-- 递归子节点 -->
    <div v-if="node.type === 'directory' && expanded && node.children" class="node-children">
      <TreeNode
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :selected-path="selectedPath"
        :level="level + 1"
        @select-file="(p) => emit('select-file', p)"
        @preview-image="(p) => emit('preview-image', p)"
      />
    </div>
  </div>
</template>

<script lang="ts">
// 自引用组件名注册（Vue SFC 递归默认支持组件名）
export default { name: "TreeNode" };
</script>

<style scoped>
.node-row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding-right: 8px;
  cursor: pointer;
  user-select: none;
  font-size: 13px;
  color: var(--murasaki-ink-2);
  border-radius: 3px;
  transition: background var(--murasaki-duration-fast) var(--murasaki-ease),
              color var(--murasaki-duration-fast) var(--murasaki-ease);
}
.node-row:hover {
  background: var(--murasaki-muted);
}
/* 键盘焦点环（仅键盘导航时出现，鼠标点击不显示） */
.node-row:focus-visible {
  outline: 2px solid var(--murasaki-primary);
  outline-offset: -2px;
}
.node-row.is-selected {
  background: var(--murasaki-primary-soft);
  color: var(--murasaki-primary);
  font-weight: 500;
}
.node-row.is-selected .md-badge {
  background: var(--murasaki-primary);
  color: var(--murasaki-primary-foreground);
}
.node-row.is-selected .node-file-icon,
.node-row.is-selected .node-folder-icon {
  color: var(--murasaki-primary);
}
.node-row.is-file:not(.is-md) {
  color: var(--murasaki-ink-3);
}
.node-row.is-image {
  cursor: grab;
}
.node-row.is-image:active {
  cursor: grabbing;
}
.node-row.is-directory {
  cursor: pointer;
  font-weight: 500;
  color: var(--murasaki-ink);
}
.node-row.is-drop-target {
  background: var(--murasaki-primary-soft);
  outline: 1px dashed var(--murasaki-primary);
  outline-offset: -1px;
}
.rename-row,
.creating-row {
  background: var(--murasaki-purple-50);
}

/* 折叠箭头：默认朝右，展开时旋转 90° */
.node-arrow {
  flex-shrink: 0;
  color: var(--murasaki-ink-3);
  transition: transform var(--murasaki-duration-fast) var(--murasaki-ease);
}
.node-arrow.is-expanded {
  transform: rotate(90deg);
}

.node-folder-icon {
  flex-shrink: 0;
  color: var(--murasaki-primary);
}

.node-file-icon {
  flex-shrink: 0;
  color: var(--murasaki-ink-3);
}

/* HTML 文件：紫色（与 markdown 徽标同色系，但用角码图标区分） */
.node-file-icon.is-html {
  color: var(--murasaki-purple-500);
}

/* Markdown 文件徽标：紫色圆角矩形里的 M */
.md-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: var(--murasaki-radius-sm);
  background: var(--murasaki-purple-100);
  color: var(--murasaki-purple-700);
  font-family: var(--murasaki-font-mono);
  font-weight: 700;
  font-size: 10px;
  flex-shrink: 0;
  letter-spacing: 0;
}

.node-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

/* 长条目自动换行方案（设置-编辑器-长条目显示） */
.node-row.wrap-mode {
  height: auto;
  min-height: 26px;
  padding-top: 3px;
  padding-bottom: 3px;
}
.node-row.wrap-mode .node-name {
  white-space: normal;
  overflow: visible;
  text-overflow: clip;
  line-height: 1.35;
  word-break: break-word;
}
.node-children {
  /* 子节点容器无需额外样式，缩进由 paddingLeft 处理 */
}

/* 触屏：放大行高 */
@media (pointer: coarse) {
  .node-row {
    height: 34px;
    font-size: 14px;
  }
  .md-badge {
    width: 20px;
    height: 20px;
    font-size: 11px;
  }
}

/* 紧凑窗口 */
@media (max-width: 980px) {
  .node-row {
    height: 24px;
    font-size: 12px;
  }
}
</style>
