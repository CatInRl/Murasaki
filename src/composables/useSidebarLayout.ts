/**
 * 侧栏布局状态（#433）。
 *
 * `App.vue` 原本把宽度 / 折叠 / 拖拽 / 持久化四件事摊在 setup 顶层，
 * 与启动编排、命令分发混在一起。抽到这里后：
 * - 状态与约束（最小/最大宽度、折叠细条宽度）集中在一处；
 * - 拖拽的 pointer 捕获与清理只在这里维护；
 * - 持久化 watcher 只在本模块注册（`initialized` 为 true 后才写回）。
 */
import { computed, ref, watch, type Ref } from "vue";

export const SIDEBAR_MIN_WIDTH = 140;
export const SIDEBAR_MAX_WIDTH = 600;
export const SIDEBAR_COLLAPSED_WIDTH = 36;
export const SIDEBAR_DEFAULT_WIDTH = 260;

export interface SidebarLayoutDeps {
  /** 初始化完成前不写回设置，避免默认值覆盖用户上次的布局 */
  initialized: Ref<boolean>;
  updateSettings(patch: Record<string, unknown>): Promise<unknown>;
}

export function useSidebarLayout({ initialized, updateSettings }: SidebarLayoutDeps) {
  const width = ref(SIDEBAR_DEFAULT_WIDTH);
  const collapsed = ref(false);
  /** 拖拽调宽进行中：关闭宽度过渡动画 + 禁用文本选择 */
  const dragging = ref(false);

  /** 侧栏实际宽度：折叠时固定细条宽度，否则用用户调整后的宽度 */
  const style = computed(() => ({
    width: collapsed.value ? `${SIDEBAR_COLLAPSED_WIDTH}px` : `${width.value}px`,
  }));

  /** 展开侧栏（折叠细条上的图标与「视图」菜单共用） */
  function expand(): void {
    collapsed.value = false;
  }

  /** 收起侧栏（展开态右上角按钮） */
  function collapse(): void {
    collapsed.value = true;
  }

  /** 恢复持久化的布局；越界宽度按上下限夹紧 */
  function restore(layout: { width?: number; collapsed: boolean }): void {
    if (layout.width) {
      width.value = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, layout.width));
    }
    collapsed.value = layout.collapsed;
  }

  /** 右缘拖拽调宽（pointer events，拖拽期间禁止过渡与文本选择） */
  function startResize(e: PointerEvent): void {
    if (collapsed.value) return;
    e.preventDefault();
    // 指针捕获：指针移入主区域（如 HTML 预览 iframe）时 pointermove/up 会被 iframe 吞掉，
    // 导致缩小侧栏后无法拖回右侧。捕获后事件始终派发到本元素，拖拽双向可靠。
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = width.value;
    dragging.value = true;
    document.body.style.userSelect = "none";
    const onMove = (ev: PointerEvent) => {
      const w = startWidth + ev.clientX - startX;
      width.value = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(w)));
    };
    const onUp = () => {
      dragging.value = false;
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  // 布局状态持久化（gated：初始化完成后才落盘）
  watch(width, (v) => {
    if (initialized.value) void updateSettings({ sidebarWidth: v });
  });
  watch(collapsed, (v) => {
    if (initialized.value) void updateSettings({ sidebarCollapsed: v });
  });

  return { width, collapsed, dragging, style, expand, collapse, restore, startResize };
}
