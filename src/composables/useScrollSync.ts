import { onBeforeUnmount } from "vue";
import { EditorView } from "@codemirror/view";

/**
 * 滚动同步选项：
 *  - editorView: 返回当前 CodeMirror EditorView 实例
 *  - previewScroller: 返回预览区滚动容器（含 data-source-line 元素的祖先）
 */
export interface ScrollSyncOptions {
  editorView: () => EditorView | null;
  previewScroller: () => HTMLElement | null;
  /** 节流间隔（ms），默认 50 */
  throttleMs?: number;
}

/**
 * 编辑器 ↔ 预览 双向滚动同步。
 *
 * 实现要点：
 *  1. 编辑器滚动 → 取可视区域顶部行号 → 在预览中查找 data-source-line <= 该行号的最后一个元素 → 滚动预览到其 offsetTop
 *  2. 预览滚动 → 取预览可视区域顶部最近的 data-source-line 元素 → 用 EditorView.scrollIntoView 滚动编辑器
 *  3. 节流 50ms，防循环：syncing 标志位 + setTimeout(0) 释放
 */
export function useScrollSync(opts: ScrollSyncOptions) {
  const throttleMs = opts.throttleMs ?? 50;

  // 防循环：一方触发的滚动会触发另一方的事件，用此标志位抑制
  let syncing = false;
  // 节流：每次滚动事件只安排一次 setTimeout
  let editorTimer: number | null = null;
  let previewTimer: number | null = null;

  function clearTimers() {
    if (editorTimer !== null) {
      clearTimeout(editorTimer);
      editorTimer = null;
    }
    if (previewTimer !== null) {
      clearTimeout(previewTimer);
      previewTimer = null;
    }
  }

  /**
   * 收集预览容器内所有带 data-source-line 的元素，按出现顺序返回。
   * querySelectorAll 默认按文档顺序，与行号递增一致。
   */
  function collectLineElements(container: HTMLElement): HTMLElement[] {
    const list = Array.from(
      container.querySelectorAll<HTMLElement>("[data-source-line]")
    );
    return list;
  }

  /**
   * 编辑器 → 预览：
   *  1. 取编辑器可视区域顶部对应的源码行号
   *  2. 在预览中找到 data-source-line <= 该行号的最后一个元素
   *  3. 滚动预览到该元素的 offsetTop（相对预览滚动容器）
   */
  function syncFromEditor() {
    const view = opts.editorView();
    const preview = opts.previewScroller();
    if (!view || !preview) return;

    const scroller = view.scrollDOM;
    const scrollTop = scroller.scrollTop;
    // lineBlockAtHeight 返回该高度处的行块信息，from 是该行起始位置
    const block = view.lineBlockAtHeight(scrollTop);
    const topLine = view.state.doc.lineAt(block.from).number;

    const elements = collectLineElements(preview);
    if (elements.length === 0) return;

    let target: HTMLElement | null = null;
    for (const el of elements) {
      const line = parseInt(el.getAttribute("data-source-line") || "0", 10);
      if (line <= topLine) {
        target = el;
      } else {
        break;
      }
    }

    if (!target) {
      // topLine 比所有元素都小 → 滚到顶部
      target = elements[0];
    }

    syncing = true;
    // offsetTop 相对最近的 positioned 祖先；预览容器本身是滚动容器，元素是其直接/间接子节点
    // 计算 target 相对 preview 的偏移
    const targetTop = relativeOffsetTop(target, preview);
    preview.scrollTop = targetTop;
    // 下一帧释放标志位，避免 preview 的 scroll 事件反向触发
    requestAnimationFrame(() => {
      syncing = false;
    });
  }

  /**
   * 预览 → 编辑器：
   *  1. 找到预览可视区域顶部最近的 data-source-line 元素
   *  2. 用其行号定位编辑器中的对应行
   *  3. dispatch scrollIntoView 效果让编辑器滚动
   */
  function syncFromPreview() {
    const view = opts.editorView();
    const preview = opts.previewScroller();
    if (!view || !preview) return;

    const elements = collectLineElements(preview);
    if (elements.length === 0) return;

    const previewTop = preview.getBoundingClientRect().top;
    // 阈值：元素顶部在预览顶部 +20px 以内视为"已露出"
    const threshold = previewTop + 20;

    let targetLine: number | null = null;
    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      if (rect.top < threshold) {
        const line = parseInt(el.getAttribute("data-source-line") || "1", 10);
        targetLine = line;
      } else {
        break;
      }
    }

    if (targetLine === null) {
      // 预览在顶部 → 编辑器也回到顶部
      targetLine = 1;
    }

    syncing = true;
    const totalLines = view.state.doc.lines;
    const lineNum = Math.min(targetLine, totalLines);
    const line = view.state.doc.line(lineNum);
    view.dispatch({
      effects: EditorView.scrollIntoView(line.from, { y: "start" }),
    });
    requestAnimationFrame(() => {
      syncing = false;
    });
  }

  /**
   * 计算 element 相对 ancestor 的 offsetTop（穿越中间定位元素）。
   */
  function relativeOffsetTop(element: HTMLElement, ancestor: HTMLElement): number {
    let top = 0;
    let node: HTMLElement | null = element;
    while (node && node !== ancestor) {
      top += node.offsetTop;
      node = node.offsetParent as HTMLElement | null;
      // 防御：如果 offsetParent 跳出到了 ancestor 之外（fixed 等），停止
      if (node && !ancestor.contains(node)) break;
    }
    return top;
  }

  function onEditorScroll() {
    if (syncing) return;
    if (editorTimer !== null) return;
    editorTimer = window.setTimeout(() => {
      editorTimer = null;
      syncFromEditor();
    }, throttleMs);
  }

  function onPreviewScroll() {
    if (syncing) return;
    if (previewTimer !== null) return;
    previewTimer = window.setTimeout(() => {
      previewTimer = null;
      syncFromPreview();
    }, throttleMs);
  }

  /**
   * 绑定滚动事件。返回一个解绑函数。
   * 通常在 onMounted 中调用，onBeforeUnmount 中调用返回的解绑函数。
   */
  function attach(
    editorScrollDom: HTMLElement | null,
    previewScroller: HTMLElement | null
  ): () => void {
    if (editorScrollDom) {
      editorScrollDom.addEventListener("scroll", onEditorScroll, { passive: true });
    }
    if (previewScroller) {
      previewScroller.addEventListener("scroll", onPreviewScroll, { passive: true });
    }
    return () => {
      if (editorScrollDom) {
        editorScrollDom.removeEventListener("scroll", onEditorScroll);
      }
      if (previewScroller) {
        previewScroller.removeEventListener("scroll", onPreviewScroll);
      }
      clearTimers();
    };
  }

  onBeforeUnmount(() => {
    clearTimers();
    syncing = false;
  });

  return {
    attach,
    /** 立即触发一次编辑器 → 预览同步（用于内容更新后对齐） */
    syncFromEditor,
    /** 立即触发一次预览 → 编辑器同步 */
    syncFromPreview,
  };
}
