import {
  computed,
  inject,
  provide,
  ref,
  type ComputedRef,
  type InjectionKey,
  type Ref,
} from "vue";

/**
 * 文件树键盘导航上下文（FileTree → TreeNode 通过 provide/inject 共享）
 *
 * 由 `FileTree.vue` 提供，`TreeNode.vue` 消费：
 * - 展开状态上移到此处统一持有，使父组件能把树扁平化为「可见条目」列表并按 ARIA tree 惯例导航
 * - roving tabindex：仅 `focusPath` 对应的节点行 `tabindex="0"`，其余为 `-1`
 * - 节点行 DOM 按路径登记，键盘移动焦点时无需做选择器转义
 */
export interface FileTreeNavContext {
  /** 当前应持有 `tabindex=0` 的节点路径；高亮失效时回退到首个可见条目 */
  focusPath: ComputedRef<string | null>;
  /** 目录是否展开 */
  isExpanded: (path: string) => boolean;
  /** 设置目录展开状态 */
  setExpanded: (path: string, value: boolean) => void;
  /** 记录当前键盘焦点所在的节点路径 */
  setActive: (path: string) => void;
  /** 登记 / 注销节点行 DOM（传 null 表示注销） */
  registerRow: (path: string, el: HTMLElement | null) => void;
  /** 取已登记的节点行 DOM */
  getRow: (path: string) => HTMLElement | null;
}

export interface FileTreeNavOptions {
  /** 已展开目录路径集合（由 FileTree 持有，用于计算可见条目） */
  expandedPaths: Ref<Set<string>>;
  /** 当前可见条目路径，按渲染顺序（用于 roving tabindex 的回退与校验） */
  visiblePaths: ComputedRef<string[]>;
}

const TREE_NAV_KEY: InjectionKey<FileTreeNavContext> = Symbol(
  "murasaki:file-tree-nav"
);

const FALLBACK: FileTreeNavContext = {
  focusPath: computed(() => null),
  isExpanded: () => false,
  setExpanded: () => {},
  setActive: () => {},
  registerRow: () => {},
  getRow: () => null,
};

/** 创建并注入文件树导航上下文（在 `FileTree.vue` 的 setup 中调用一次） */
export function provideFileTreeNav(
  options: FileTreeNavOptions
): FileTreeNavContext {
  const { expandedPaths, visiblePaths } = options;
  const activePath = ref<string | null>(null);
  const rows = new Map<string, HTMLElement>();

  const ctx: FileTreeNavContext = {
    focusPath: computed(() => {
      const active = activePath.value;
      if (active && visiblePaths.value.includes(active)) return active;
      return visiblePaths.value[0] ?? null;
    }),
    isExpanded: (path) => expandedPaths.value.has(path),
    setExpanded: (path, value) => {
      const next = new Set(expandedPaths.value);
      if (value) next.add(path);
      else next.delete(path);
      expandedPaths.value = next;
    },
    setActive: (path) => {
      activePath.value = path;
    },
    registerRow: (path, el) => {
      if (el) rows.set(path, el);
      else rows.delete(path);
    },
    getRow: (path) => rows.get(path) ?? null,
  };

  provide(TREE_NAV_KEY, ctx);
  return ctx;
}

/**
 * 消费文件树导航上下文。无 provider 时退化为空实现，
 * 使 `TreeNode.vue` 可独立挂载（例如组件测试）而不崩溃。
 */
export function useFileTreeNav(): FileTreeNavContext {
  return inject(TREE_NAV_KEY) ?? FALLBACK;
}
