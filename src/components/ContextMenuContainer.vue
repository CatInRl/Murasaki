<script setup lang="ts">
/**
 * 右键菜单容器 — 单一 Teleport 容器
 *
 * - 全应用仅挂载一处（App.vue），通过 useContextMenuStore 驱动
 * - 边界检测：菜单超出视窗时自动翻向（右侧溢出 → 左侧，底部溢出 → 上方）
 * - 关闭时机：点击菜单项 / 点击外部 / Escape / 任意滚动 / 窗口 resize
 * - 菜单项 hover / 键盘高亮：实心紫底白字（var(--murasaki-primary) / --murasaki-primary-foreground）
 * - 键盘导航：↑↓ 移动高亮（跳过禁用项与分隔符，循环）、Home/End 首尾、Enter/Space 执行、Esc 关闭
 *   打开时焦点移入菜单，Esc 关闭后归还给打开前的元素（点击关闭不归还，避免抢走用户的点击焦点）
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

/** 键盘高亮项在 menu.items 中的下标；-1 表示无 */
const activeIndex = ref(-1);
/** 打开菜单前的焦点元素，仅 Esc 关闭时归还 */
let triggerEl: HTMLElement | null = null;
let restoreFocusOnClose = false;

const visible = computed(() => menu.visible);
const activeId = computed(() =>
  activeIndex.value >= 0 ? `murasaki-context-menu-item-${activeIndex.value}` : undefined
);

/** 是否可被高亮 / 执行（非分隔符且未禁用） */
function isSelectable(item: MenuItem | undefined): boolean {
  return !!item && !item.separator && !item.disabled;
}

/** 从 start 起按 step 方向找第一个可选项并高亮 */
function setActiveFrom(start: number, step: 1 | -1): void {
  const len = menu.items.length;
  for (let i = start; i >= 0 && i < len; i += step) {
    if (isSelectable(menu.items[i])) {
      activeIndex.value = i;
      return;
    }
  }
  activeIndex.value = -1;
}

/** 相对当前高亮项按 step 移动（首尾循环） */
function moveActive(step: 1 | -1): void {
  const len = menu.items.length;
  if (len === 0) return;
  const from = activeIndex.value < 0 ? (step === 1 ? -1 : 0) : activeIndex.value;
  for (let k = 1; k <= len; k++) {
    const i = (((from + step * k) % len) + len) % len;
    if (isSelectable(menu.items[i])) {
      activeIndex.value = i;
      return;
    }
  }
}

/** 执行某项（键盘与鼠标共用） */
async function activate(index: number): Promise<void> {
  const item = menu.items[index];
  if (!isSelectable(item)) return;
  menu.hide();
  await nextTick();
  if (item.action) {
    await item.action();
  }
}

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
      triggerEl = (document.activeElement as HTMLElement | null) ?? null;
      restoreFocusOnClose = false;
      setActiveFrom(0, 1);
      await applyPosition();
      attachListeners();
      await nextTick();
      menuEl.value?.focus();
    } else {
      detachListeners();
      if (restoreFocusOnClose) {
        const el = triggerEl;
        if (el && document.contains(el)) {
          el.focus({ preventScroll: true });
        }
      }
      triggerEl = null;
      restoreFocusOnClose = false;
      activeIndex.value = -1;
    }
  }
);

watch(
  () => [menu.x, menu.y, menu.items.length],
  async () => {
    if (menu.visible) {
      setActiveFrom(0, 1);
      await applyPosition();
    }
  }
);

function onKeydown(e: KeyboardEvent): void {
  if (!menu.visible) return;
  switch (e.key) {
    case "Escape":
      e.preventDefault();
      e.stopPropagation();
      restoreFocusOnClose = true;
      menu.hide();
      break;
    case "ArrowDown":
      e.preventDefault();
      e.stopPropagation();
      moveActive(1);
      break;
    case "ArrowUp":
      e.preventDefault();
      e.stopPropagation();
      moveActive(-1);
      break;
    case "Home":
      e.preventDefault();
      e.stopPropagation();
      setActiveFrom(0, 1);
      break;
    case "End":
      e.preventDefault();
      e.stopPropagation();
      setActiveFrom(menu.items.length - 1, -1);
      break;
    case "Enter":
    case " ":
      e.preventDefault();
      e.stopPropagation();
      void activate(activeIndex.value);
      break;
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

/** 鼠标 hover 与键盘高亮保持一致 */
function onItemHover(index: number): void {
  if (isSelectable(menu.items[index])) {
    activeIndex.value = index;
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
      role="menu"
      tabindex="-1"
      :aria-activedescendant="activeId"
      :style="{ left: renderX + 'px', top: renderY + 'px' }"
      @contextmenu.prevent.stop
      @mousedown.stop
    >
      <template v-for="(item, idx) in menu.items" :key="idx">
        <div
          v-if="item.separator"
          class="murasaki-context-menu-separator"
          role="separator"
        ></div>
        <div
          v-else
          :id="`murasaki-context-menu-item-${idx}`"
          class="murasaki-context-menu-item"
          role="menuitem"
          :aria-disabled="item.disabled || undefined"
          :class="{
            'is-disabled': item.disabled,
            'is-danger': item.danger,
            'is-active': idx === activeIndex,
          }"
          @click.stop="activate(idx)"
          @mouseenter="onItemHover(idx)"
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
  outline: none;
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

.murasaki-context-menu-item:hover:not(.is-disabled),
.murasaki-context-menu-item.is-active:not(.is-disabled) {
  background: var(--murasaki-primary);
  color: var(--murasaki-primary-foreground);
}

.murasaki-context-menu-item:hover:not(.is-disabled) .murasaki-context-menu-icon,
.murasaki-context-menu-item.is-active:not(.is-disabled) .murasaki-context-menu-icon {
  color: var(--murasaki-primary-foreground);
}

.murasaki-context-menu-item:hover:not(.is-disabled) .murasaki-context-menu-shortcut,
.murasaki-context-menu-item.is-active:not(.is-disabled) .murasaki-context-menu-shortcut {
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

.murasaki-context-menu-item.is-danger:hover:not(.is-disabled),
.murasaki-context-menu-item.is-danger.is-active:not(.is-disabled) {
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
