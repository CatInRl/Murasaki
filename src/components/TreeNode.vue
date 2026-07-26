<script setup lang="ts">
import { ref, computed } from "vue";
import { NDropdown, NInput } from "naive-ui";
import type { DropdownOption } from "naive-ui";
import { useFileOpsStore } from "../stores/useFileOpsStore";
import type { TreeNode } from "../types";

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

const expanded = ref(props.level === 0); // 顶层默认展开

// ===== 右键菜单状态 =====
const menuVisible = ref(false);
const menuX = ref(0);
const menuY = ref(0);

// ===== 重命名状态 =====
const renaming = ref(false);
const renameValue = ref("");

// ===== 新建文件/文件夹对话框 =====
const creating = ref(false);
const creatingType = ref<"file" | "directory">("file");
const creatingName = ref("");

function toggle(): void {
  if (props.node.type === "directory") {
    expanded.value = !expanded.value;
  }
}

function onClick(): void {
  if (renaming.value || creating.value) return;
  if (props.node.type === "file") {
    if (isMarkdownFile(props.node.name)) {
      emit("select-file", props.node.path);
    } else if (isImageFile(props.node.name)) {
      // 图片文件点击 → 弹预览窗
      emit("preview-image", props.node.path);
    }
  } else {
    toggle();
  }
}

function isMarkdownFile(name: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(name);
}

/** 判断是否为图片文件（用于拖入编辑器插入相对路径引用） */
function isImageFile(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
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
      alert(`移动失败: ${err}`);
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
        alert(`复制失败: ${err}`);
      }
    }
  }
}

function isSelected(): boolean {
  return props.selectedPath === props.node.path;
}

// ===== 右键菜单 =====
function onContextMenu(e: MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
  menuX.value = e.clientX;
  menuY.value = e.clientY;
  menuVisible.value = true;
}

function closeMenu(): void {
  menuVisible.value = false;
}

const menuOptions = computed<DropdownOption[]>(() => {
  const isDir = props.node.type === "directory";
  const isFile = props.node.type === "file";
  const options: DropdownOption[] = [];

  // 文件类型专属：打开 / 预览
  if (isFile) {
    if (isMarkdownFile(props.node.name)) {
      options.push({ label: "打开", key: "open" });
    } else if (isImageFile(props.node.name)) {
      options.push({ label: "预览", key: "preview" });
    }
  }

  if (isDir) {
    options.push({ label: "新建文件", key: "new-file" });
    options.push({ label: "新建文件夹", key: "new-folder" });
  }

  options.push({ type: "divider", key: "d0" });

  options.push({ label: "重命名", key: "rename" });
  options.push({ label: "剪切", key: "cut" });
  options.push({ label: "复制", key: "copy" });

  if (isDir && fileOps.hasClipboard()) {
    options.push({ label: "粘贴", key: "paste" });
  }

  options.push({ type: "divider", key: "d1" });
  options.push({ label: "复制路径", key: "copy-path" });
  options.push({ label: "复制相对路径", key: "copy-rel-path" });

  options.push({ type: "divider", key: "d2" });
  options.push({ label: "删除", key: "delete" });
  options.push({ label: "在资源管理器中显示", key: "reveal" });

  return options;
});

async function onMenuSelect(key: string): Promise<void> {
  closeMenu();
  const node = props.node;

  switch (key) {
    case "open":
      emit("select-file", node.path);
      break;
    case "preview":
      emit("preview-image", node.path);
      break;
    case "new-file":
      creatingType.value = "file";
      creatingName.value = "";
      creating.value = true;
      break;
    case "new-folder":
      creatingType.value = "directory";
      creatingName.value = "";
      creating.value = true;
      break;
    case "rename":
      renameValue.value = node.name;
      renaming.value = true;
      break;
    case "cut":
      fileOps.cut(node.path);
      break;
    case "copy":
      fileOps.copy(node.path);
      break;
    case "paste":
      try {
        await fileOps.paste(node.path);
      } catch (err) {
        alert(`粘贴失败: ${err}`);
      }
      break;
    case "copy-path":
      try {
        await fileOps.copyAbsolutePath(node.path);
      } catch (err) {
        alert(`复制路径失败: ${err}`);
      }
      break;
    case "copy-rel-path":
      try {
        await fileOps.copyRelativePath(node.path);
      } catch (err) {
        alert(`复制相对路径失败: ${err}`);
      }
      break;
    case "delete":
      if (confirm(`确定要删除 "${node.name}" 吗？（移至回收站）`)) {
        try {
          await fileOps.deletePath(node.path);
        } catch (err) {
          alert(`删除失败: ${err}`);
        }
      }
      break;
    case "reveal":
      try {
        await fileOps.revealInExplorer(node.path);
      } catch (err) {
        alert(`无法在资源管理器中显示: ${err}`);
      }
      break;
  }
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
    alert(`重命名失败: ${err}`);
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
      expanded.value = true;
    }
  } catch (err) {
    alert(`新建失败: ${err}`);
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
      class="node-row"
      :class="{
        'is-directory': node.type === 'directory',
        'is-file': node.type === 'file',
        'is-selected': isSelected(),
        'is-md': isMarkdownFile(node.name),
        'is-image': isImageFile(node.name),
        'is-drop-target': isDropTarget,
      }"
      :style="{ paddingLeft: level * 12 + 8 + 'px' }"
      :draggable="(node.type === 'file') || (node.type === 'directory')"
      @click="onClick"
      @contextmenu="onContextMenu"
      @dragstart="onDragStart"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <span class="node-icon">
        <template v-if="node.type === 'directory'">
          {{ expanded ? "▾" : "▸" }}
        </template>
        <template v-else>
          <span v-if="isMarkdownFile(node.name)" class="md-icon">M</span>
          <span v-else-if="isImageFile(node.name)" class="img-icon">🖼</span>
          <span v-else class="file-dot">·</span>
        </template>
      </span>
      <span class="node-name" :title="node.path">{{ node.name }}</span>
    </div>

    <!-- 重命名输入框（替换节点行） -->
    <div
      v-else
      class="node-row rename-row"
      :style="{ paddingLeft: level * 12 + 8 + 'px' }"
    >
      <span class="node-icon">
        <template v-if="node.type === 'directory'">
          {{ expanded ? "▾" : "▸" }}
        </template>
        <template v-else>
          <span v-if="isMarkdownFile(node.name)" class="md-icon">M</span>
          <span v-else class="file-dot">·</span>
        </template>
      </span>
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
      :style="{ paddingLeft: (level + 1) * 12 + 8 + 'px' }"
    >
      <span class="node-icon">
        {{ creatingType === "file" ? "·" : "▸" }}
      </span>
      <NInput
        v-model:value="creatingName"
        size="tiny"
        autofocus
        :placeholder="creatingType === 'file' ? '新文件名.md' : '新文件夹名'"
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

    <!-- 右键下拉菜单 -->
    <NDropdown
      placement="bottom-start"
      trigger="manual"
      :x="menuX"
      :y="menuY"
      :options="menuOptions"
      :show="menuVisible"
      :on-clickoutside="closeMenu"
      @select="onMenuSelect"
    />
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
  gap: 4px;
  height: 26px;
  padding-right: 8px;
  cursor: pointer;
  user-select: none;
  font-size: 13px;
  color: #333;
  border-radius: 3px;
  transition: background 0.1s;
}
.node-row:hover {
  background: rgba(0, 0, 0, 0.05);
}
.node-row.is-selected {
  background: rgba(24, 160, 88, 0.12);
  color: #18a058;
}
.node-row.is-file:not(.is-md) {
  color: #999;
  cursor: default;
}
.node-row.is-file:not(.is-md):hover {
  background: transparent;
}
.rename-row,
.creating-row {
  background: rgba(24, 160, 88, 0.06);
}
.node-icon {
  width: 16px;
  text-align: center;
  font-size: 12px;
  flex-shrink: 0;
  color: #666;
}
.md-icon {
  color: #18a058;
  font-weight: bold;
  font-size: 11px;
}
.img-icon {
  font-size: 12px;
  filter: grayscale(0.2);
}
.file-dot {
  color: #ccc;
}
.node-row.is-image {
  cursor: grab;
}
.node-row.is-image:active {
  cursor: grabbing;
}
.node-row.is-directory {
  cursor: pointer;
}
.node-row.is-drop-target {
  background: rgba(24, 160, 88, 0.18);
  outline: 1px dashed #18a058;
  outline-offset: -1px;
}
.node-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-children {
  /* 子节点容器无需额外样式，缩进由 paddingLeft 处理 */
}
</style>
