<script setup lang="ts">
/**
 * 右键菜单容器 — 单一 Teleport 容器
 *
 * - 全应用仅挂载一处（App.vue），通过 useContextMenuStore 驱动
 * - 边界检测：菜单超出视窗时自动翻向（右侧溢出 → 左侧，底部溢出 → 上方）
 * - 关闭时机：点击菜单项 / 点击外部 / Escape / 任意滚动 / 窗口 resize
 * - 菜单项 hover：实心紫底白字（var(--murasaki-primary) / --murasaki-primary-foreground）
 */
import { ref, watch, nextTick, onBeforeUnmount, computed } from "vue";
import {
  useContextMenuStore,
  clampToViewport,
  type MenuItem,
} from "../stores/useContextMenuStore";

const menu = useContextMenuStore();
const menuEl = ref<HTMLDivElement | null>(null);

/** 实际渲染坐标（边界检测后） */
const renderX = ref(0);
const renderY = ref(0);

const visible = computed(() => menu.visible);

/** 读取菜单尺寸并应用边界检测后的坐标 */
async function applyPosition(): Promise<void> {
  renderX.value = menu.x;
  renderY.value = menu.y;
  await nextTick();
  const el = menuEl.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const pos = clampToViewport(
    menu.x,
    menu.y,
    rect.width,
    rect.height,
    window.innerWidth,
    window.innerHeight
  );
  renderX.value = pos.x;
  renderY.value = pos.y;
}

function attachListeners(): void {
  window.addEventListener("keydown", onKeydown, true);
  window.addEventListener("scroll", onScrollClose, { capture: true, passive: true });
  window.addEventListener("mousedown", onMousedown, true);
  window.addEventListener("resize", onResizeClose);
}

function detachListeners(): void {
  window.removeEventListener("keydown", onKeydown, true);
  window.removeEventListener("scroll", onScrollClose, { capture: true, passive: true } as EventListenerOptions);
  window.removeEventListener("mousedown", onMousedown, true);
  window.removeEventListener("resize", onResizeClose);
}

watch(
  () => menu.visible,
  async (v) => {
    if (v) {
      await applyPosition();
      attachListeners();
    } else {
      detachListeners();
    }
  }
);

watch(
  () => [menu.x, menu.y, menu.items.length],
  async () => {
    if (menu.visible) {
      await applyPosition();
    }
  }
);

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && menu.visible) {
    e.preventDefault();
    e.stopPropagation();
    menu.hide();
  }
}

function onScrollClose(): void {
  if (menu.visible) menu.hide();
}

function onResizeClose(): void {
  if (menu.visible) menu.hide();
}

function onMousedown(e: MouseEvent): void {
  const el = menuEl.value;
  if (el && !el.contains(e.target as Node)) {
    menu.hide();
  }
}

async function onItemClick(item: MenuItem): Promise<void> {
  if (item.separator || item.disabled) return;
  menu.hide();
  await nextTick();
  if (item.action) {
    await item.action();
  }
}

onBeforeUnmount(() => {
  detachListeners();
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="menuEl"
      class="murasaki-context-menu"
      :style="{ left: renderX + 'px', top: renderY + 'px' }"
      @contextmenu.prevent.stop
      @mousedown.stop
    >
      <template v-for="(item, idx) in menu.items" :key="idx">
        <div
          v-if="item.separator"
          class="murasaki-context-menu-separator"
        ></div>
        <div
          v-else
          class="murasaki-context-menu-item"
          :class="{
            'is-disabled': item.disabled,
            'is-danger': item.danger,
          }"
          @click.stop="onItemClick(item)"
          @mousedown.stop
        >
          <component
            v-if="item.icon"
            :is="item.icon"
            :size="14"
            class="murasaki-context-menu-icon"
          />
          <span class="murasaki-context-menu-label">{{ item.label }}</span>
          <span
            v-if="item.shortcut"
            class="murasaki-context-menu-shortcut"
            >{{ item.shortcut }}</span
          >
        </div>
      </template>
    </div>
  </Teleport>
</template>

<style>
.murasaki-context-menu {
  position: fixed;
  z-index: 9999;
  min-width: 180px;
  max-width: 280px;
  padding: 4px 0;
  background: var(--murasaki-popover);
  border: 1px solid var(--murasaki-border);
  border-radius: var(--murasaki-radius-md);
  box-shadow: var(--murasaki-shadow-2);
  font-size: var(--murasaki-text-sm);
  color: var(--murasaki-ink);
  font-family: var(--murasaki-font-ui);
  user-select: none;
  animation: murasaki-context-menu-in var(--murasaki-duration-fast)
    var(--murasaki-ease-out);
  transform-origin: top left;
}

@keyframes murasaki-context-menu-in {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.murasaki-context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  color: var(--murasaki-ink);
  transition: background var(--murasaki-duration-fast) var(--murasaki-ease),
    color var(--murasaki-duration-fast) var(--murasaki-ease);
}

.murasaki-context-menu-item:hover:not(.is-disabled) {
  background: var(--murasaki-primary);
  color: var(--murasaki-primary-foreground);
}

.murasaki-context-menu-item:hover:not(.is-disabled) .murasaki-context-menu-icon {
  color: var(--murasaki-primary-foreground);
}

.murasaki-context-menu-item:hover:not(.is-disabled) .murasaki-context-menu-shortcut {
  color: var(--murasaki-primary-foreground);
  opacity: 0.85;
}

.murasaki-context-menu-item.is-disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.murasaki-context-menu-item.is-danger {
  color: var(--murasaki-state-error);
}

.murasaki-context-menu-item.is-danger:hover:not(.is-disabled) {
  background: var(--murasaki-state-error);
  color: #fff;
}

.murasaki-context-menu-icon {
  flex-shrink: 0;
  color: var(--murasaki-ink-3);
}

.murasaki-context-menu-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.murasaki-context-menu-shortcut {
  flex-shrink: 0;
  font-size: var(--murasaki-text-xs);
  color: var(--murasaki-ink-3);
  font-family: var(--murasaki-font-mono);
}

.murasaki-context-menu-separator {
  height: 1px;
  margin: 4px 8px;
  background: var(--murasaki-line);
}
</style>
